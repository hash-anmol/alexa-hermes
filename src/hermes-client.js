'use strict';
// Client for the Hermes agent. Three ways to reach it (config.json -> "hermes".mode):
//
//   "local"    Hermes is installed on this machine: runs `hermes chat ...` (default; "cli" is an alias).
//   "ssh"      Hermes is installed on another machine you can ssh into without a password: runs it there through ssh.
//   "gateway"  Hermes runs elsewhere with its API server turned on (API_SERVER_ENABLED, API_SERVER_KEY): talks to its
//              OpenAI-compatible /v1/chat/completions endpoint over HTTP(S). No ssh and no hermes binary needed here.
//
// Verified against Hermes Agent v0.22.5 (local, ssh): plain `-Q` prints nothing on stdout when there is no TTY, so we
// use `--format stream-json` and read the final {"type":"result","text":...} event.
//
// hermes block:
//   mode          "local" | "ssh" | "gateway"
//   bin           path to the hermes binary (local, ssh; use an absolute path for ssh: its PATH is minimal)
//   ssh           ssh host alias or user@host (ssh)
//   url, token    gateway base URL (e.g. http://hermes-box:8642) and its API_SERVER_KEY (gateway; the env var HERMES_API_KEY works too)
//   profile       Hermes profile that answers (local/ssh: `hermes -p`; gateway: /p/<profile>/..., needs gateway.multiplex_profiles)
//   session       optional named session to keep voice context across requests, e.g. "alexa"
//   source        optional session source tag (local, ssh)
//   notifyTarget  target for `hermes send`, e.g. "slack:Jane Doe" (local, ssh; used to message you when a long task ends)
//   yolo          true: never stop to ask permission for a command (local, ssh: `--yolo`; on a gateway set approvals off there)
//   timeoutMs, maxTurns, runBudgetSec, toolsets

const { spawn } = require('child_process');
const { loadConfig } = require('./lib/config');
const yolo = require('./lib/yolo');

const TRIGGER = /^\s*(?:(?:ask|tell|hey|ok)\s+)?hermes\b[\s,:.-]*/i;
const SPOKEN_RULES = 'Answer for a voice speaker: plain text, no markdown, no lists, under 300 characters.';
// For the live spoken stream: what you write before and between tool calls is read aloud as it appears, so say what you intend to do.
const VOICE_RULES =
    'You are talking through an Alexa speaker, and your text is read aloud while you work. Plain text only: no markdown, no lists, no code. ' +
    "Before you start something that needs tools, say one short sentence about what you are about to do, for example: I'll check your calendar. " +
    'Keep the final answer under 300 characters unless I asked for detail. If something fails, say plainly what failed.';

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function toSpokenText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Runs a process, feeds it stdin, enforces a hard timeout.
function run(bin, args, { input = '', timeoutMs = 90000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (fn, v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(v);
        };
        // Reject immediately on timeout; don't wait for the child's pipes to close.
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(reject, new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (e) => finish(reject, e));
        child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

function hermesArgs(cfg, base) {
    const args = [...base];
    if (cfg.yolo && base[0] === 'chat') args.push('--yolo'); // never stop to ask permission for a command
    if (cfg.source) args.push('--source', cfg.source);
    if (cfg.session) args.push('--continue', cfg.session, '--create-if-missing');
    if (cfg.maxTurns) args.push('--max-turns', String(cfg.maxTurns));
    if (cfg.runBudgetSec) args.push('--run-budget', String(cfg.runBudgetSec));
    if (cfg.toolsets) args.push('-t', cfg.toolsets);
    if (cfg.profile && cfg.profile !== 'default') args.unshift('-p', cfg.profile); // which Hermes profile answers
    return args;
}

// Builds the process to spawn: the hermes binary directly, or ssh <host> '<hermes ...>'.
function invocation(cfg, args) {
    const hbin = cfg.bin || 'hermes';
    if (cfg.mode === 'ssh') {
        if (!cfg.ssh) throw new Error('hermes.ssh (host alias) is not set in config.json');
        const remote = [hbin, ...args].map(shq).join(' ');
        return {
            bin: 'ssh',
            args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', cfg.ssh, remote],
        };
    }
    return { bin: hbin, args };
}

function parseStream(stdout) {
    let result = null;
    const chunks = [];
    for (const line of String(stdout).split('\n')) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        let ev;
        try {
            ev = JSON.parse(s);
        } catch {
            continue;
        }
        if (ev.type === 'text' && typeof ev.text === 'string') chunks.push(ev.text);
        if (ev.type === 'result') result = ev;
    }
    if (result) {
        return { text: result.text ?? chunks.join(''), exitCode: result.exit_code ?? 0, sessionId: result.session_id };
    }
    if (chunks.length) return { text: chunks.join(''), exitCode: 0 };
    return null;
}

const tail = (s, n = 300) => String(s || '').trim().split('\n').filter((l) => !/COMPOSIO_API_KEY|^# /.test(l)).join(' ').slice(-n);

// ---- gateway mode: Hermes' own OpenAI-compatible API server ----

const gatewayUrl = (cfg) => {
    if (!cfg.url) throw new Error('hermes.url (the gateway address) is not set in config.json');
    const base = String(cfg.url).replace(/\/+$/, '').replace(/\/v1$/, '');
    const profile = cfg.profile && cfg.profile !== 'default' ? `/p/${encodeURIComponent(cfg.profile)}` : '';
    return `${base}${profile}/v1/chat/completions`;
};

// Reads one Server-Sent-Events body and calls onFrame({event, data}) for each complete frame.
async function readSse(body, onFrame) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + (buf[i] === '\r' ? 4 : 2));
            let event = 'message';
            const data = [];
            for (const line of raw.split(/\r?\n/)) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (data.length && onFrame({ event, data: data.join('\n') }) === false) return;
        }
    }
}

// Streams one question through the gateway. onEvent gets the same events as the CLI stream:
//   {type:'text', text}  {type:'tool_use', name, label}  {type:'tool_result', name}
async function gatewayStream(cfg, message, onEvent, { signal, rules } = {}) {
    const token = cfg.token || process.env.HERMES_API_KEY;
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cfg.session && token) headers['X-Hermes-Session-Id'] = String(cfg.session); // keeps the conversation, needs the API key
    const ms = cfg.timeoutMs || 90000;
    const ctl = new AbortController();
    let why = null;
    const timer = setTimeout(() => ((why = `timed out after ${ms}ms`), ctl.abort()), ms);
    const onAbort = () => ((why = 'cancelled'), ctl.abort());
    if (signal) signal.aborted ? onAbort() : signal.addEventListener('abort', onAbort, { once: true });
    let text = '';
    try {
        const res = await fetch(gatewayUrl(cfg), {
            method: 'POST',
            headers,
            signal: ctl.signal,
            body: JSON.stringify({
                model: cfg.model || 'hermes-agent',
                stream: true,
                messages: [{ role: 'system', content: rules || SPOKEN_RULES }, { role: 'user', content: message }],
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Hermes gateway ${res.status}: ${tail(body)}`);
        }
        let failure = null;
        await readSse(res.body, ({ event, data }) => {
            if (data === '[DONE]') return false;
            let j;
            try {
                j = JSON.parse(data);
            } catch {
                return;
            }
            if (event === 'hermes.tool.progress') {
                if (j.status === 'running') onEvent({ type: 'tool_use', name: j.tool, label: j.label });
                else if (j.status === 'completed') onEvent({ type: 'tool_result', name: j.tool });
                return;
            }
            if (event === 'approval.request') {
                failure = 'Hermes gateway needs approval for a command. Turn approvals off (YOLO) on the gateway';
                return false;
            }
            if (event !== 'message') return;
            if (j.error) {
                failure = `Hermes gateway error: ${(j.error && j.error.message) || JSON.stringify(j.error)}`;
                return false;
            }
            const choice = j.choices && j.choices[0];
            const piece = choice && choice.delta && choice.delta.content;
            if (piece) {
                text += piece;
                onEvent({ type: 'text', text: piece });
            }
            if (choice && choice.finish_reason === 'error') failure = 'Hermes gateway reported a failed run';
            if (choice && choice.finish_reason === 'cancelled') failure = 'cancelled';
        });
        if (failure) throw new Error(failure);
        const spoken = toSpokenText(text);
        if (!spoken) throw new Error('Hermes returned an empty reply');
        return { text: spoken };
    } catch (e) {
        if (why) throw new Error(why);
        throw e;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

// Returns Hermes' reply as plain text a speaker can read. Throws on failure.
// opts can override config.json's hermes block (e.g. { timeoutMs, session: null, rules }).
async function askHermes(utterance, opts = {}) {
    const cfg = { ...(loadConfig().hermes || {}), ...opts };
    cfg.yolo = opts.yolo ?? yolo.isOn(cfg);
    const message = String(utterance).replace(TRIGGER, '').trim() || String(utterance).trim();

    if (cfg.mode === 'gateway') return (await gatewayStream(cfg, message, () => {}, { signal: opts.signal, rules: cfg.rules })).text;

    const prompt = `${cfg.rules || SPOKEN_RULES}\n\n${message}`;
    const { bin, args } = invocation(cfg, hermesArgs(cfg, ['chat', '-Q', '--format', 'stream-json', '--query-file', '-']));
    const { code, stdout, stderr } = await run(bin, args, { input: prompt, timeoutMs: cfg.timeoutMs || 90000 });

    const parsed = parseStream(stdout);
    if (!parsed) throw new Error(`Hermes returned no reply (exit ${code}): ${tail(stderr)}`);
    if (parsed.exitCode !== 0) throw new Error(`Hermes failed (exit ${parsed.exitCode}): ${tail(parsed.text || stderr)}`);

    const text = toSpokenText(parsed.text);
    if (!text) throw new Error('Hermes returned an empty reply');
    return text;
}

// Same question as askHermes, but reports Hermes' stream-json events as they happen:
//   {type:'tool_use', name}, {type:'tool_result'}, {type:'text', text}  (deltas)  and finally resolves {text}.
// Used for spoken answers that start before Hermes has finished. Throws on failure like askHermes.
function streamHermes(utterance, onEvent, opts = {}) {
    const cfg = { ...(loadConfig().hermes || {}), ...opts };
    cfg.yolo = opts.yolo ?? yolo.isOn(cfg);
    const message = String(utterance).replace(TRIGGER, '').trim() || String(utterance).trim();

    if (cfg.mode === 'gateway') return gatewayStream(cfg, message, (ev) => {
        try {
            onEvent(ev);
        } catch {
            /* a broken listener must not kill the stream */
        }
    }, { signal: opts.signal, rules: cfg.rules });

    const prompt = `${cfg.rules || SPOKEN_RULES}\n\n${message}`;
    const { bin, args } = invocation(cfg, hermesArgs(cfg, ['chat', '-Q', '--format', 'stream-json', '--query-file', '-']));
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        let pending = '';
        let result = null;
        let streamed = '';
        let settled = false;
        const done = (fn, v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(v);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            done(reject, new Error(`timed out after ${cfg.timeoutMs || 90000}ms`));
        }, cfg.timeoutMs || 90000);
        if (opts.signal) {
            const stop = () => {
                child.kill('SIGKILL');
                done(reject, new Error('cancelled'));
            };
            if (opts.signal.aborted) stop();
            else opts.signal.addEventListener('abort', stop, { once: true });
        }

        const line = (raw) => {
            const s = raw.trim();
            if (!s.startsWith('{')) return;
            let ev;
            try {
                ev = JSON.parse(s);
            } catch {
                return;
            }
            if (ev.type === 'result') result = ev;
            if (ev.type === 'text' && typeof ev.text === 'string') streamed += ev.text;
            if (ev.type === 'text' || ev.type === 'tool_use' || ev.type === 'tool_result') {
                try {
                    onEvent(ev);
                } catch {
                    /* a broken listener must not kill the stream */
                }
            }
        };
        child.stdout.on('data', (d) => {
            pending += d;
            let i;
            while ((i = pending.indexOf('\n')) >= 0) {
                line(pending.slice(0, i));
                pending = pending.slice(i + 1);
            }
        });
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (e) => done(reject, e));
        child.on('close', (code) => {
            line(pending);
            if (!result && !streamed) return done(reject, new Error(`Hermes returned no reply (exit ${code}): ${tail(stderr)}`));
            if (result && (result.exit_code ?? 0) !== 0) return done(reject, new Error(`Hermes failed (exit ${result.exit_code}): ${tail(result.text || stderr)}`));
            done(resolve, { text: toSpokenText((result && result.text) || streamed) });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
    });
}

// Sends a plain message to the configured messaging target (e.g. a Slack DM) with `hermes send`.
// No LLM involved, so it is fast and cheap.
async function sendMessage(text, opts = {}) {
    const cfg = { ...(loadConfig().hermes || {}), ...opts };
    if (cfg.mode === 'gateway') throw new Error('hermes send is not available through a gateway');
    if (!cfg.notifyTarget) throw new Error('hermes.notifyTarget is not set in config.json');
    const { bin, args } = invocation(cfg, ['send', '-t', cfg.notifyTarget, '-q', '-f', '-']);
    const { code, stderr } = await run(bin, args, { input: text, timeoutMs: cfg.timeoutMs || 30000 });
    if (code !== 0) throw new Error(`hermes send failed (exit ${code}): ${tail(stderr)}`);
}

module.exports = { askHermes, streamHermes, sendMessage, VOICE_RULES, toSpokenText, parseStream, invocation, hermesArgs, gatewayUrl, TRIGGER };
