'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Never read the machine's real config.json (it sets hermes.ssh etc. and would change what these tests mean).
process.env.ALEXA_HERMES_CONFIG = path.join(os.tmpdir(), 'no-such-hey-claude-config.json');
const { askHermes, sendMessage, parseStream, toSpokenText } = require('../src/hermes-client');

let dir;
let fakeHermes;
let fakeSsh;

// Fake `hermes`: records stdin + args, prints a stream-json reply like the real v0.22.5 CLI does.
const hermesScript = (body) => `#!/bin/sh
cat > "${'$'}FAKE_OUT/stdin.txt"
printf '%s\\n' "$@" > "${'$'}FAKE_OUT/args.txt"
echo "Config ref COMPOSIO_API_KEY is not set (check ~/.hermes/.env); keeping the literal placeholder" >&2
${body}
`;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-'));
    process.env.FAKE_OUT = dir;
    process.env.ALEXA_HERMES_CONFIG = path.join(dir, 'config.json'); // no config -> defaults
    fakeHermes = path.join(dir, 'hermes');
    fs.writeFileSync(
        fakeHermes,
        hermesScript(`echo '{"type": "system", "subtype": "init", "model": "", "session_id": ""}'
echo '{"type": "text", "text": "Good "}'
echo '{"type": "result", "session_id": "s1", "exit_code": 0, "text": "**Good** morning, it is sunny."}'
echo 'session_id: s1' >&2`),
        { mode: 0o755 }
    );
    // Fake `ssh`: records its args, then runs the remote command string locally, like sshd would.
    fakeSsh = path.join(dir, 'bin');
    fs.mkdirSync(fakeSsh);
    fs.writeFileSync(path.join(fakeSsh, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${'$'}FAKE_OUT/ssh_args.txt"\nfor last; do :; done\nexec sh -c "$last"\n`, { mode: 0o755 });
    process.env.PATH = `${fakeSsh}:${process.env.PATH.split(':').filter((p) => !p.includes('/hermes-')).join(':')}`;
});

const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

test('parseStream takes the final result event and ignores noise', () => {
    const out = ['Config warning', '{"type":"text","text":"p"}', '{"type":"text","text":"ong"}', 'not json {', '{"type":"result","exit_code":0,"text":"pong","session_id":"s"}'].join('\n');
    assert.deepEqual(parseStream(out), { text: 'pong', exitCode: 0, sessionId: 's' });
    assert.equal(parseStream('{"type":"text","text":"a"}\n{"type":"text","text":"b"}').text, 'ab', 'falls back to streamed chunks');
    assert.equal(parseStream('nothing useful'), null);
});

test('toSpokenText strips markdown and tags', () => {
    assert.equal(toSpokenText('**Hi** _there_ `x` <b>you</b>\n\n# Title'), 'Hi there x you Title');
});

test('local mode: runs hermes with the right flags, prompt via stdin, returns clean spoken text', async () => {
    const reply = await askHermes("ask hermes what's on my calendar", { bin: fakeHermes, session: 'alexa', source: 'alexa' });
    assert.equal(reply, 'Good morning, it is sunny.');

    const args = read('args.txt').trim().split('\n');
    assert.deepEqual(args, ['chat', '-Q', '--format', 'stream-json', '--query-file', '-', '--source', 'alexa', '--continue', 'alexa', '--create-if-missing']);
    const stdin = read('stdin.txt');
    assert.match(stdin, /voice speaker/);
    assert.match(stdin, /what's on my calendar/);
    assert.doesNotMatch(stdin, /ask hermes/, 'spoken trigger words are removed');
});

test('stdin keeps tricky characters verbatim (no shell interpretation)', async () => {
    const nasty = `it's "quoted" $(whoami) \`id\` ; rm -rf /`;
    await askHermes(nasty, { bin: fakeHermes });
    assert.ok(read('stdin.txt').includes(nasty));
});

test('ssh mode: ssh <alias> with a safely quoted remote command, same result', async () => {
    const reply = await askHermes('good morning', { mode: 'ssh', ssh: 'hermes-box', bin: fakeHermes, session: 'alexa' });
    assert.equal(reply, 'Good morning, it is sunny.');
    const ssh = read('ssh_args.txt').trim().split('\n');
    assert.deepEqual(ssh.slice(0, 6), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15']);
    assert.equal(ssh[6], 'hermes-box');
    assert.ok(ssh[7].startsWith(`'${fakeHermes}' 'chat' '-Q'`), `remote command was: ${ssh[7]}`);
    assert.match(read('stdin.txt'), /good morning/, 'prompt travelled through ssh stdin');
});

test('ssh mode without a host alias is a clear error', async () => {
    await assert.rejects(askHermes('hi', { mode: 'ssh', bin: fakeHermes }), /hermes\.ssh/);
});

test('Hermes exits non-zero with no reply -> error that includes the useful stderr, not the Composio noise', async () => {
    fs.writeFileSync(fakeHermes, hermesScript('echo "boom: model unavailable" >&2\nexit 1'), { mode: 0o755 });
    await assert.rejects(askHermes('hi', { bin: fakeHermes }), (e) => /boom: model unavailable/.test(e.message) && !/COMPOSIO/.test(e.message));
});

test('Hermes reports a failed run in the result event -> error', async () => {
    fs.writeFileSync(fakeHermes, hermesScript(`echo '{"type":"result","exit_code":2,"text":"max turns reached"}'`), { mode: 0o755 });
    await assert.rejects(askHermes('hi', { bin: fakeHermes }), /max turns reached/);
});

test('empty reply is an error (so callers use their fallback)', async () => {
    fs.writeFileSync(fakeHermes, hermesScript(`echo '{"type":"result","exit_code":0,"text":"  "}'`), { mode: 0o755 });
    await assert.rejects(askHermes('hi', { bin: fakeHermes }), /empty/);
});

test('a hung Hermes is killed and reported promptly', async () => {
    fs.writeFileSync(fakeHermes, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const t0 = Date.now();
    await assert.rejects(askHermes('hi', { bin: fakeHermes, timeoutMs: 300 }), /timed out/);
    assert.ok(Date.now() - t0 < 3000);
});

test('sendMessage uses `hermes send -t <target>` with the text on stdin', async () => {
    fs.writeFileSync(fakeHermes, hermesScript('exit 0'), { mode: 0o755 });
    await sendMessage('⏰ not up yet', { bin: fakeHermes, notifyTarget: 'slack:Jane Doe' });
    assert.deepEqual(read('args.txt').trim().split('\n'), ['send', '-t', 'slack:Jane Doe', '-q', '-f', '-']);
    assert.equal(read('stdin.txt'), '⏰ not up yet');
});

test('sendMessage without a target explains what to configure', async () => {
    await assert.rejects(sendMessage('x', { bin: fakeHermes }), /notifyTarget/);
});

// ---- gateway mode: a fake Hermes API server speaking the same SSE the real one does ----

const http = require('http');
const { streamHermes, gatewayUrl } = require('../src/hermes-client');

function fakeGateway(handler) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
            handler(req, res, seen);
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const chunk = (content) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const sse = (res, parts) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const p of parts) res.write(p);
    res.end('data: [DONE]\n\n');
};

test('gateway mode: posts to /v1/chat/completions with the key and session, streams text and tool progress', async () => {
    const gw = await fakeGateway((req, res) =>
        sse(res, [
            chunk('I will check your calendar. '),
            `event: hermes.tool.progress\ndata: ${JSON.stringify({ tool: 'calendar', label: 'calendar', status: 'running', toolCallId: 'c1' })}\n\n`,
            `event: hermes.tool.progress\ndata: ${JSON.stringify({ tool: 'calendar', status: 'completed', toolCallId: 'c1' })}\n\n`,
            chunk('You have **two** meetings.'),
        ])
    );
    try {
        const events = [];
        const out = await streamHermes('what is on today', (e) => events.push(e), { mode: 'gateway', url: gw.url, token: 'k123', session: 'alexa' });
        assert.equal(out.text, 'I will check your calendar. You have two meetings.');
        assert.deepEqual(events.map((e) => e.type), ['text', 'tool_use', 'tool_result', 'text']);
        assert.equal(events[1].name, 'calendar');
        const req = gw.seen[0];
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer k123');
        assert.equal(req.headers['x-hermes-session-id'], 'alexa');
        assert.equal(req.body.stream, true);
        assert.equal(req.body.messages[1].content, 'what is on today');
        assert.match(req.body.messages[0].content, /voice speaker/);
        assert.equal(await askHermes('again', { mode: 'gateway', url: gw.url, token: 'k123' }), 'I will check your calendar. You have two meetings.');
    } finally {
        gw.server.close();
    }
});

test('gateway mode: a profile uses the /p/<profile>/ prefix; a trailing /v1 in the url is fine', () => {
    assert.equal(gatewayUrl({ url: 'http://h:8642/' }), 'http://h:8642/v1/chat/completions');
    assert.equal(gatewayUrl({ url: 'http://h:8642/v1', profile: 'sally' }), 'http://h:8642/p/sally/v1/chat/completions');
    assert.equal(gatewayUrl({ url: 'http://h:8642', profile: 'default' }), 'http://h:8642/v1/chat/completions');
    assert.throws(() => gatewayUrl({}), /hermes\.url/);
});

test('gateway mode: wrong key, approval request, empty reply and a hung gateway are clear errors', async () => {
    const { explain } = require('../src/lib/errors');
    const bad = await fakeGateway((req, res) => (res.writeHead(401, { 'Content-Type': 'application/json' }), res.end('{"error":{"message":"Invalid gateway API key"}}')));
    const approval = await fakeGateway((req, res) => sse(res, [`event: approval.request\ndata: ${JSON.stringify({ command: 'rm -rf x' })}\n\n`]));
    const empty = await fakeGateway((req, res) => sse(res, []));
    const hung = await fakeGateway(() => {});
    try {
        await assert.rejects(askHermes('hi', { mode: 'gateway', url: bad.url, token: 'nope' }), (e) => (assert.match(e.message, /gateway 401/), assert.equal(explain(e).kind, 'gateway-auth'), true));
        await assert.rejects(askHermes('hi', { mode: 'gateway', url: approval.url }), (e) => explain(e).kind === 'approval');
        await assert.rejects(askHermes('hi', { mode: 'gateway', url: empty.url }), /empty reply/);
        const t0 = Date.now();
        await assert.rejects(askHermes('hi', { mode: 'gateway', url: hung.url, timeoutMs: 150 }), /timed out after 150ms/);
        assert.ok(Date.now() - t0 < 1500);
        const ctl = new AbortController();
        setTimeout(() => ctl.abort(), 50);
        await assert.rejects(streamHermes('hi', () => {}, { mode: 'gateway', url: hung.url, signal: ctl.signal }), /cancelled/);
        await assert.rejects(sendMessage('x', { mode: 'gateway', url: bad.url, notifyTarget: 'slack:me' }), /not available through a gateway/);
    } finally {
        for (const g of [bad, approval, empty, hung]) g.server.closeAllConnections ? (g.server.closeAllConnections(), g.server.close()) : g.server.close();
    }
});
