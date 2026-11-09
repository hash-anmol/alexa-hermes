'use strict';
// `alexa-hermes doctor`: checks everything the skill needs and says how to fix what is missing.
// Every check returns { name, status: 'pass' | 'warn' | 'fail', detail, fix? }. `exec` and `fetchFn` are injectable for tests.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isPlaceholder } = require('./config-wizard');
const { gatewayUrl } = require('./hermes-client');

function defaultExec(bin, args, ms = 10000) {
    return new Promise((resolve) => {
        let out = '';
        let err = '';
        let child;
        try {
            child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            return resolve({ code: -1, out, err: e.message });
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ code: null, out, err: `${err} timed out after ${ms}ms`, timedOut: true });
        }, ms);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: -1, out, err: e.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
        });
    });
}

const defaultFetch = (url, opts = {}, ms = 6000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
const expand = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());
const check = (name, status, detail, fix) => ({ name, status, detail, ...(fix ? { fix } : {}) });
const version = (r) => (/v?\d+\.\d+(?:\.\d+)?/.exec(`${r.out} ${r.err}`) || [''])[0];

async function runChecks(config, { exec = defaultExec, fetchFn = defaultFetch, audioDir, configFile, nodeVersion = process.versions.node } = {}) {
    const out = [];
    const h = config.hermes || {};
    const sk = config.skill || {};
    const mode = h.mode || 'local';

    const major = Number(String(nodeVersion).split('.')[0]);
    out.push(major >= 18 ? check('Node.js', 'pass', `v${nodeVersion}`) : check('Node.js', 'fail', `v${nodeVersion} is too old`, 'Install Node.js 18 or newer.'));

    if (!Object.keys(config).length) {
        out.push(check('config.json', 'fail', 'not found or not valid JSON', 'Run: alexa-hermes init'));
        return out;
    }
    if (configFile && fs.existsSync(configFile) && process.platform !== 'win32') {
        const mode600 = (fs.statSync(configFile).mode & 0o077) === 0;
        out.push(mode600 ? check('config.json permissions', 'pass', 'only you can read it') : check('config.json permissions', 'warn', 'other users on this machine can read it', `chmod 600 ${configFile}`));
    }

    // ---- Hermes, in whichever mode ----
    if (mode === 'gateway') {
        const base = String(h.url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
        if (!base) out.push(check('Hermes gateway', 'fail', 'hermes.url is not set', 'Set hermes.url to the gateway address, like http://hermes-box:8642'));
        else {
            try {
                const res = await fetchFn(`${base}/health`, {});
                out.push(res.ok ? check('Hermes gateway reachable', 'pass', `${base}/health answered`) : check('Hermes gateway reachable', 'fail', `${base}/health answered ${res.status}`, 'Is the API server enabled on that Hermes? (API_SERVER_ENABLED=true, then restart the gateway)'));
            } catch (e) {
                out.push(check('Hermes gateway reachable', 'fail', e.message, 'Check the address, the firewall, and that `hermes gateway` is running with the API server on.'));
            }
            const token = h.token || process.env.HERMES_API_KEY;
            if (!token) out.push(check('Hermes gateway key', 'fail', 'no hermes.token (or HERMES_API_KEY) set', 'Set it to the API_SERVER_KEY of that Hermes. The Hermes API server requires a key.'));
            else {
                try {
                    const res = await fetchFn(`${base}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
                    out.push(res.ok ? check('Hermes gateway key', 'pass', 'accepted') : check('Hermes gateway key', 'fail', `answered ${res.status}`, 'hermes.token must equal API_SERVER_KEY on the Hermes machine.'));
                } catch (e) {
                    out.push(check('Hermes gateway key', 'warn', e.message));
                }
            }
            try {
                out.push(check('Hermes gateway address', 'pass', gatewayUrl(h)));
            } catch (e) {
                out.push(check('Hermes gateway address', 'fail', e.message));
            }
        }
    } else if (mode === 'ssh') {
        if (!h.ssh) out.push(check('Hermes over ssh', 'fail', 'hermes.ssh is not set', 'Set hermes.ssh to an ssh alias or user@host.'));
        else {
            const r = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', h.ssh, `${h.bin || 'hermes'} --version 2>&1`], 15000);
            if (r.code === 0 && version(r)) out.push(check('Hermes over ssh', 'pass', `${h.ssh}: Hermes ${version(r)}`));
            else if (/Permission denied|publickey/i.test(r.err)) out.push(check('Hermes over ssh', 'fail', 'ssh needs a password or key', `Set up key login so this works with no prompt: ssh ${h.ssh} true`));
            else if (r.code === 0) out.push(check('Hermes over ssh', 'fail', `${h.ssh} answered but no Hermes version was printed`, 'Set hermes.bin to the absolute path of the hermes binary on that machine (try: ssh host which hermes).'));
            else out.push(check('Hermes over ssh', 'fail', (r.err || r.out || 'no answer').trim().slice(-160), `Make sure this works with no prompt: ssh ${h.ssh} ${h.bin || 'hermes'} --version`));
        }
    } else {
        const r = await exec(h.bin || 'hermes', ['--version'], 15000);
        const v = version(r);
        out.push(r.code === 0 && v ? check('Hermes (local)', 'pass', `Hermes ${v}`) : check('Hermes (local)', 'fail', (r.err || r.out || 'not found').trim().slice(-160), 'Install Hermes Agent, or set hermes.bin to its full path. If Hermes runs on another machine use mode "ssh" or "gateway".'));
    }

    // ---- the Alexa side ----
    out.push(isPlaceholder(sk.applicationId)
        ? check('Alexa skill id', 'fail', 'skill.applicationId is not set', 'Create the skill (docs/ALEXA-SKILL.md), then paste its id (amzn1.ask.skill...) into config.json. Without it every request is refused.')
        : check('Alexa skill id', 'pass', String(sk.applicationId).slice(0, 24) + '...'));
    if (isPlaceholder(sk.publicBase) || !/^https:\/\//.test(sk.publicBase)) out.push(check('Public HTTPS address', 'fail', 'skill.publicBase is not an https:// address', 'Alexa only talks to HTTPS. See docs/TUNNELS.md (Tailscale Funnel, Cloudflare Tunnel, ngrok).'));
    else {
        try {
            const res = await fetchFn(`${sk.publicBase}/health`, {});
            const body = await res.text();
            out.push(res.ok && body.trim() === 'ok' ? check('Public HTTPS address', 'pass', `${sk.publicBase}/health answers ok`) : check('Public HTTPS address', 'fail', `${sk.publicBase}/health answered ${res.status}`, 'Is the skill server running (alexa-hermes start) and the tunnel pointing at its port?'));
        } catch (e) {
            out.push(check('Public HTTPS address', 'fail', e.message, 'Is the skill server running (alexa-hermes start) and the tunnel up?'));
        }
    }
    try {
        const res = await fetchFn(`http://127.0.0.1:${sk.port || 8787}/health`, {}, 2000);
        out.push(res.ok ? check('Skill server', 'pass', `running on port ${sk.port || 8787}`) : check('Skill server', 'fail', `answered ${res.status}`));
    } catch {
        out.push(check('Skill server', 'warn', `not running on port ${sk.port || 8787}`, 'Start it: alexa-hermes start (or install the service: alexa-hermes service install).'));
    }

    // ---- spoken answers (optional: without them the skill answers with text) ----
    const ff = await exec('ffmpeg', ['-version'], 5000);
    out.push(ff.code === 0 ? check('ffmpeg', 'pass', 'found') : check('ffmpeg', 'warn', 'not found (spoken answers need it)', 'Install ffmpeg (apt install ffmpeg / brew install ffmpeg).'));
    const sp = sk.speech || {};
    if (sp.enabled === false) out.push(check('Kokoro voice', 'warn', 'spoken answers are turned off in config.json'));
    else {
        const py = sp.python || 'python3';
        const imp = await exec(py, ['-c', 'import kokoro_onnx, soundfile'], 15000);
        const model = expand(sp.model || '~/.kokoro/kokoro-v0_19.onnx');
        const voices = expand(sp.voices || '~/.kokoro/voices.bin');
        if (imp.code !== 0) out.push(check('Kokoro voice', 'warn', `${py} cannot import kokoro_onnx and soundfile`, 'Run ./setup.sh --voice to install them, or accept text answers.'));
        else if (!fs.existsSync(model) || !fs.existsSync(voices)) out.push(check('Kokoro voice', 'warn', 'model files are missing', `Run ./setup.sh --voice (expects ${model} and ${voices}).`));
        else out.push(check('Kokoro voice', 'pass', 'python packages and model files found'));
    }

    // ---- the alarm sound (optional) ----
    const dir = audioDir || require('./lib/config').AUDIO_DIR;
    let sounds = [];
    try {
        sounds = fs.readdirSync(dir).filter((f) => /\.(mp3|m4a|aac)$/i.test(f));
    } catch {
        /* no folder */
    }
    out.push(sounds.length ? check('Alarm sound', 'pass', `${sounds[0]} (say "ring the alarm")`) : check('Alarm sound', 'warn', `no mp3 in ${dir}`, 'Optional. Copy your own mp3 there to use "ring the alarm". Keep it out of git (the folder is ignored).'));
    return out;
}

const ICON = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
function format(results) {
    const lines = results.map((r) => `${ICON[r.status]}  ${r.name}: ${r.detail}${r.fix ? `\n      fix: ${r.fix}` : ''}`);
    const fails = results.filter((r) => r.status === 'fail').length;
    const warns = results.filter((r) => r.status === 'warn').length;
    lines.push('', fails ? `${fails} problem${fails > 1 ? 's' : ''} to fix before it works.` : warns ? `Ready. ${warns} optional thing${warns > 1 ? 's' : ''} noted above.` : 'All good.');
    return lines.join('\n');
}

module.exports = { runChecks, format, defaultExec };
