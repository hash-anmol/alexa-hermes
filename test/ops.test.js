'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.ALEXA_HERMES_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ops-')), 'data');

const test = require('node:test');
const assert = require('node:assert/strict');
const { explain } = require('../src/lib/errors');
const yolo = require('../src/lib/yolo');
const { createHealth, parseDisk, parseMem } = require('../src/health');
const { hermesArgs } = require('../src/hermes-client');
const { createVoice } = require('../src/voice');

test('explain: each failure gets its own plain sentence', () => {
    const cases = [
        ['Tailscale SSH requires an additional check. Visit https://login.tailscale.com/a/abc', 'tailscale', /approve SSH/],
        ['ssh: connect to host x port 22: Connection timed out', 'unreachable', /can't reach Hermes/],
        ['timed out after 240000ms', 'timeout', /too long/],
        ['HTTP 429 rate limit exceeded', 'quota', /rate limited/],
        ['401 Unauthorized invalid api key', 'auth', /rejected/],
        ['502 bad gateway from provider', 'model', /provider/],
        ['hermes: command not found', 'missing', /isn't installed/],
        ['Hermes returned no reply (exit 1)', 'silent', /didn't say anything/],
        ['cancelled', 'cancelled', /stopped/],
        ['something odd', 'unknown', /Something went wrong/],
    ];
    for (const [msg, kind, re] of cases) {
        const e = explain(new Error(msg));
        assert.equal(e.kind, kind, msg);
        assert.match(e.spoken, re);
    }
    assert.equal(explain(null).kind, 'unknown');
});

test('yolo: the voice switch wins over the config default', () => {
    assert.equal(yolo.isOn({}), false);
    assert.equal(yolo.isOn({ yolo: true }), true);
    yolo.set(false);
    assert.equal(yolo.isOn({ yolo: true }), false);
    yolo.set(true);
    assert.equal(yolo.isOn({}), true);
});

test('hermesArgs: --yolo only for chat, profile first, default profile adds nothing', () => {
    const chat = ['chat', '-Q'];
    assert.deepEqual(hermesArgs({ yolo: true, profile: 'sally', session: 'alexa' }, chat).slice(0, 4), ['-p', 'sally', 'chat', '-Q']);
    assert.ok(hermesArgs({ yolo: true }, chat).includes('--yolo'));
    assert.ok(!hermesArgs({ yolo: false }, chat).includes('--yolo'));
    assert.ok(!hermesArgs({ yolo: true }, ['send', '-t', 'x']).includes('--yolo'));
    assert.ok(!hermesArgs({ profile: 'default' }, chat).includes('-p'));
});

test('health parsers', () => {
    assert.deepEqual(parseDisk('Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 100000000 82000000 18000000 82% /'), { usedPct: 82, freeGB: 17.2, totalGB: 95 });
    assert.deepEqual(parseMem('              total used free shared buff/cache available\nMem: 7900 5000 500 10 2400 2600'), { totalMB: 7900, availableMB: 2600 });
    assert.equal(parseDisk('garbage'), null);
});

const AZ_OK = 'HEY_OK\nFilesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda1 100000000 50000000 50000000 50% /\n total used free shared buff/cache available\nMem: 7900 3000 2000 10 2900 4500\n0.40 0.50 0.60 1/200 123\nCPUS 2\nHV Hermes Agent v0.22.5\n';
const HOME_OUT = { 'df -P /': 'x\n/dev/a 100000000 40000000 60000000 40% /', 'free -m': 'h\nMem: 7700 2000 1000 10 4700 4400', 'cat /proc/loadavg': '0.07 0.05 0.01 1/100 1', nproc: '4', active: 'active' };
function fakeExec(az) {
    return async (bin, args) => {
        if (bin === 'ssh') return typeof az === 'function' ? az() : { code: 0, out: az, err: '' };
        const cmd = args[1];
        if (/is-active/.test(cmd)) return { code: 0, out: 'active\n', err: '' };
        if (/--failed/.test(cmd)) return { code: 0, out: '', err: '' };
        return { code: 0, out: HOME_OUT[cmd] || '', err: '' };
    };
}
const cfg = { hermes: { mode: 'ssh', ssh: 'hermes-box', bin: '/h/hermes' }, skill: { publicBase: 'https://x.ts.net' }, health: { bridgeName: 'the home server', hermesName: 'the Azure server' } };

test('health.test: up, slow, and unreachable are each spoken plainly', async () => {
    const up = await createHealth({ config: cfg, exec: fakeExec(AZ_OK) }).test();
    assert.match(up.spoken, /Azure server is up and Hermes version 0.22.5 answered/);
    const busy = await createHealth({ config: cfg, exec: fakeExec(AZ_OK.replace('0.40 0.50 0.60', '6.70 5.00 4.00')) }).test();
    assert.match(busy.spoken, /busy, load 6.7 on 2 cores/);
    const down = await createHealth({ config: cfg, exec: fakeExec(() => ({ code: 255, out: '', err: 'ssh: connect to host x port 22: Connection timed out' })) }).test();
    assert.match(down.spoken, /can't reach Hermes/);
    const slow = await createHealth({ config: cfg, exec: fakeExec(() => ({ code: null, out: '', err: 'timed out', timedOut: true })) }).test();
    assert.match(slow.spoken, /didn't answer in time/);
});

test('health.report: all good, and the problem comes first when something is wrong', async () => {
    const fetchFn = async () => ({ ok: true });
    const good = await createHealth({ config: cfg, exec: fakeExec(AZ_OK), fetchFn }).report();
    assert.match(good.spoken, /^Everything is working\./);
    assert.match(good.spoken, /The home server: storage: 57.2 of 95 gigabytes free, 40 percent used/);
    assert.match(good.spoken, /The Azure server: storage: 47.7 of 95 gigabytes free, 50 percent used/);

    const bad = await createHealth({ config: cfg, exec: fakeExec(AZ_OK.replace('50000000 50000000 50%', '90000000 10000000 90%').replace('0.40 0.50', '6.70 5.00')), fetchFn: async () => { throw new Error('down'); } }).report();
    assert.match(bad.spoken, /^Heads up: .*public Alexa link.*disk on the Azure server is 90 percent full.*overloaded/);
    assert.ok(bad.issues.length >= 3);
});

// ---- long tasks in the voice stream ----
const audio = { chime: () => Buffer.alloc(120, 'c'), silence: () => Buffer.alloc(3000, 's'), speak: async (t) => Buffer.from(`S${t}~`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GET = { method: 'GET' };
function fakeRes() {
    const res = { writes: [], ended: false };
    res.writeHead = () => {};
    res.write = (b) => res.writes.push(b);
    res.end = () => (res.ended = true);
    res.on = () => {};
    return res;
}
const heard = (res) => res.writes.map((b) => b.toString()).filter((t) => t.startsWith('S')).map((t) => t.slice(1, -1));
function mk(stream, config = {}, extra = {}) {
    const state = { pending: null, writePending: (p) => (state.pending = p), clearPending: () => (state.pending = null) };
    const notes = [];
    const voice = createVoice({ audio, streamHermes: stream, state, config: { skill: { speech: { foregroundSec: 0.3, ackMs: 60000, stillMs: 60000, ...config } } }, tickMs: 15, log: () => {}, notify: async (t) => notes.push(t), ...extra });
    return { voice, state, notes };
}

test('long task: after the foreground window it hands off, keeps working, then notifies and keeps the answer', async () => {
    let finish;
    const { voice, state, notes } = mk((q, on, o) => new Promise((res) => {
        on({ type: 'tool_use', name: 'web_search' });
        finish = () => res({ text: 'The long report is finished and attached.' });
    }));
    const res = fakeRes();
    voice.attach(voice.start('big job').id, GET, res);
    await sleep(500);
    assert.ok(res.ended, 'the stream is closed');
    assert.match(heard(res).join(' '), /taking more than/);
    assert.equal(state.pending.status, 'working');
    assert.equal(state.pending.background, true);
    assert.ok(state.pending.progress.some((p) => /Searching the web/.test(p.text)), 'tool steps are kept as progress');
    finish();
    await sleep(50);
    assert.equal(state.pending.status, 'ready');
    assert.equal(state.pending.answer, 'The long report is finished and attached.');
    assert.match(notes[0], /finished "big job".*long report/);
});

test('long task that fails: the friendly error is kept and sent to Slack', async () => {
    let fail;
    const { voice, state, notes } = mk(() => new Promise((_, rej) => (fail = () => rej(new Error('HTTP 429 rate limit')))));
    voice.attach(voice.start('job').id, GET, fakeRes());
    await sleep(500);
    fail();
    await sleep(50);
    assert.match(state.pending.answer, /rate limited/);
    assert.match(notes[0], /hit a problem/);
});

test('cancel: aborts the run, says nothing scary, clears the pending task; cancel with nothing running is false', async () => {
    let signal;
    const { voice, state, notes } = mk((q, on, o) => new Promise((_, rej) => {
        signal = o.signal;
        o.signal.addEventListener('abort', () => rej(new Error('cancelled')));
    }), { foregroundSec: 60 });
    assert.equal(voice.cancel(), false);
    const res = fakeRes();
    voice.attach(voice.start('job').id, GET, res);
    await sleep(60);
    assert.equal(voice.cancel(), true);
    await sleep(80);
    assert.ok(signal.aborted);
    assert.ok(res.ended);
    assert.equal(state.pending, null);
    assert.deepEqual(notes, []);
    assert.deepEqual(heard(res), [], 'no error speech for a cancel');
});

test('the profile, the voice rules and a preface reach Hermes and the stream', async () => {
    let got;
    const { voice } = mk(async (q, on, o) => ((got = o), { text: 'Fine, all good with that today.' }), { foregroundSec: 60 });
    const res = fakeRes();
    voice.attach(voice.start('hi', { profile: 'sally', preface: 'Your earlier task finished.' }).id, GET, res);
    await sleep(100);
    assert.equal(got.profile, 'sally');
    assert.match(got.rules, /read aloud/);
    assert.deepEqual(heard(res), ['Your earlier task finished.', 'Fine, all good with that today.']);
});

test('permission hint: only when yolo is off and the answer mentions needing approval', async () => {
    for (const [yoloOn, expectHint] of [[false, true], [true, false]]) {
        const { voice } = mk(async () => ({ text: 'I need your approval before I can delete that file.' }), { foregroundSec: 60 }, { isYolo: () => yoloOn });
        const res = fakeRes();
        voice.attach(voice.start('x').id, GET, res);
        await sleep(100);
        assert.equal(heard(res).some((t) => /yolo mode/.test(t)), expectHint);
    }
});

// ---- 15-minute stream: pulses, check-ins, jobs ----
test('quiet stretches get a soft chime every pulse, and a spoken check-in every few minutes', async () => {
    const soft = Buffer.alloc(200, 'p');
    const a2 = { ...audio, softChime: () => soft };
    let release;
    const state = { pending: null, writePending: (p) => (state.pending = p), clearPending: () => (state.pending = null) };
    const voice = createVoice({
        audio: a2,
        streamHermes: () => new Promise((res) => (release = () => res({ text: 'All finished with that long job.' }))),
        state,
        config: { skill: { speech: { foregroundSec: 60, pulseSec: 0.1, reportMinutes: 0.005, ackMs: 60000, stillMs: 60000 } } },
        tickMs: 15,
        log: () => {},
    });
    const res = fakeRes();
    voice.attach(voice.start('long one').id, GET, res);
    await sleep(700);
    release();
    await sleep(100);
    const pulses = res.writes.filter((b) => b[0] === 0x70).length;
    assert.ok(pulses >= 2, `soft chimes while quiet (${pulses})`);
    assert.ok(heard(res).some((t) => /Still working\. \d+ minutes in/.test(t)), 'check-in spoken');
    assert.equal(heard(res).at(-1), 'All finished with that long job.', 'and the answer is simply spoken when done, unasked');
});

test('the default window is 15 minutes: a task that ends inside it is spoken live, never handed off', async () => {
    const { voice, state, notes } = mk(async () => ({ text: 'Done well within the window today.' }), { foregroundSec: undefined });
    const res = fakeRes();
    voice.attach(voice.start('x').id, GET, res);
    await sleep(120);
    assert.deepEqual(heard(res), ['Done well within the window today.']);
    assert.equal(state.pending, null);
    assert.deepEqual(notes, []);
});

test('startJob: a non-AI job gets the same stream; its says are spoken, its result is the last line', async () => {
    const { voice } = mk(async () => ({ text: 'unused' }), { foregroundSec: 60 });
    const res = fakeRes();
    const { id } = voice.startJob('update Hermes', async ({ say, signal }) => {
        say('Checking for a Hermes update.');
        assert.ok(signal);
        return 'Update done. Hermes is now version 0.24.0.';
    });
    voice.attach(id, GET, res);
    await sleep(120);
    assert.deepEqual(heard(res), ['Checking for a Hermes update.', 'Update done. Hermes is now version 0.24.0.']);
});

// ---- real checks, split by machine, and the updater ----
const AZ_TOP = `${AZ_OK}TOPMEM\n995000 chrome\n610000 node\n580000 hermes\n`;
test('test home / test Azure are separate, run real commands and name the biggest memory users', async () => {
    const calls = [];
    const base = fakeExec(AZ_TOP);
    const exec = async (bin, args, ms) => {
        calls.push([bin, args.join(' ')]);
        if (bin === 'sh' && /TOPMEM/.test(args[1])) return { code: 0, out: 'TOPMEM\n1300000 chrome\n200000 node\n', err: '' };
        return base(bin, args, ms);
    };
    const hc = createHealth({ config: cfg, exec, fetchFn: async () => ({ ok: true }) });
    const az = await hc.testHermes();
    assert.match(az.spoken, /Azure server is up/);
    assert.match(az.spoken, /most memory: chrome 972 megabytes, node 596 megabytes, hermes 566 megabytes/);
    assert.ok(calls.some(([b, a]) => b === 'ssh' && /df -P/.test(a) && /free -m/.test(a) && /ps -eo/.test(a)), 'one ssh with df, free and ps');
    const home = await hc.testBridge();
    assert.match(home.spoken, /^The home server is up and the Alexa link is working\./);
    assert.match(home.spoken, /most memory: chrome 1.2 gigabytes, node 195 megabytes/);
    assert.ok(calls.some(([b, a]) => b === 'sh' && /systemctl --user is-active alexa-hermes/.test(a)));
    const both = await hc.test();
    assert.match(both.spoken, /home server is up.*Azure server is up/);

    // values come from the command output, not from the code
    const other = await createHealth({ config: cfg, exec: fakeExec(AZ_OK.replace('50%', '77%').replace('50000000 50000000', '77000000 23000000')) }).testHermes();
    assert.match(other.spoken, /storage: 21.9 of 95 gigabytes free, 77 percent used/);
});

test('updateHermes: already current, updates and says done, failure, unreachable', async () => {
    const said = [];
    const mkExec = (check, update, vers) => {
        let v = 0;
        return async (bin, args) => {
            const script = args[args.length - 1];
            if (/update --check/.test(script)) return { code: 0, out: check, err: '' };
            if (/update --yes/.test(script)) return { code: 0, out: update, err: '' };
            return { code: 0, out: AZ_OK.replace('v0.22.5', vers[Math.min(v++, vers.length - 1)]), err: '' };
        };
    };
    const hc = (e) => createHealth({ config: cfg, exec: e });

    const same = await hc(mkExec('✓ Up to date with the latest release (stable v0.22.5).\nEXIT=0\n', '', ['v0.22.5'])).updateHermes({ say: (t) => said.push(t) });
    assert.match(same, /already up to date/);

    said.length = 0;
    const ok = await hc(mkExec('Update available: v0.23.0\nEXIT=0\n', 'Installed.\nEXIT=0\n', ['v0.22.5', 'v0.23.0'])).updateHermes({ say: (t) => said.push(t) });
    assert.deepEqual(said, ['Checking for a Hermes update.', 'An update is available. Updating Hermes now. This can take a few minutes.']);
    assert.match(ok, /^Update done\. Hermes is now version 0\.23\.0, it was 0\.22\.5\./);

    const bad = await hc(mkExec('Update available\nEXIT=0\n', 'git pull failed: dirty tree\nEXIT=1\n', ['v0.22.5'])).updateHermes();
    assert.match(bad, /update failed: git pull failed: dirty tree/);

    const down = await createHealth({ config: cfg, exec: fakeExec(() => ({ code: 255, out: '', err: 'ssh: connect to host x port 22: Connection timed out' })) }).updateHermes();
    assert.match(down, /can't update Hermes\. I can't reach Hermes/);
});

test('health details: storage, memory, swap, load trend, uptime, services, containers and busiest tasks come from the command output', async () => {
    const DETAIL = 'TOPMEM\n995000 chrome\n610000 node\nUPTIME up 3 weeks, 2 days\nPROCS 214\nSVCS 41\nCONTAINERS twenty-server slashdocs-db \nFAILED \nTOPCPU\n155 studio.main\n60 chrome\nENDCPU\n';
    const SWAP = AZ_OK.replace('\n0.40 0.50 0.60', '\nSwap: 8192 3700 4492\n6.70 5.20 4.10');
    const az = await createHealth({ config: cfg, exec: fakeExec(SWAP + DETAIL) }).testHermes();
    const t = az.spoken;
    assert.match(t, /storage: 47.7 of 95 gigabytes free, 50 percent used/);
    assert.match(t, /memory: 4.4 gigabytes available of 7.7 gigabytes, 3.3 gigabytes in use/);
    assert.match(t, /swap: 3.6 gigabytes used of 8 gigabytes/);
    assert.match(t, /load 6.7 \(over five minutes 5.2, fifteen minutes 4.1\) on 2 cores, high/);
    assert.match(t, /up 3 weeks, 2 days/);
    assert.match(t, /214 processes and 41 services running/);
    assert.match(t, /2 docker containers running: twenty-server and slashdocs-db/);
    assert.match(t, /busiest right now: studio.main 155 percent of a core, chrome 60 percent of a core/);
    assert.match(t, /most memory: chrome 972 megabytes, node 596 megabytes/);
    // nothing claimed when the machine reported nothing
    const bare = (await createHealth({ config: cfg, exec: fakeExec(AZ_OK) }).testHermes()).spoken;
    assert.doesNotMatch(bare, /docker|busiest|swap|up \d/);
});
