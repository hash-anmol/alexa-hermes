'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-skill-'));
process.env.ALEXA_HERMES_DATA = path.join(tmp, 'data');
process.env.ALEXA_HERMES_AUDIO = path.join(tmp, 'audio');
fs.mkdirSync(process.env.ALEXA_HERMES_AUDIO, { recursive: true });
const AUDIO = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
fs.writeFileSync(path.join(process.env.ALEXA_HERMES_AUDIO, 'alarm.mp3'), AUDIO);
fs.writeFileSync(path.join(tmp, 'outside.mp3'), 'SECRET FILE OUTSIDE THE AUDIO FOLDER');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const state = require('../src/state');
const { handle, QUERY_INTENTS, RING_SAMPLES, parseToken } = require('../src/handlers');
const { createServer } = require('../src/server');
const { buildModel } = require('../src/gen-model');

const APP = 'amzn1.ask.skill.test';
let clock = 1_000_000;
function ctxWith(over = {}) {
    const said = [];
    const logs = [];
    const asked = [];
    return {
        said,
        logs,
        asked,
        config: { skill: { applicationId: APP, fastReplyMs: 50 }, hermes: { notifyTarget: 'slack:me' } },
        askHermes: async (t) => (asked.push(t), 'You have two meetings today.'),
        say: async (t) => void said.push(t),
        state,
        now: () => clock,
        log: (m) => logs.push(m),
        audioUrl: (f) => `https://skill.example/audio/SECRET/${f}`,
        ...over,
    };
}
const intent = (name, query) => ({ request: { type: 'IntentRequest', intent: { name, slots: query === undefined ? {} : { query: { name: 'query', value: query } } } } });
const reset = () => fs.rmSync(process.env.ALEXA_HERMES_DATA, { recursive: true, force: true });
const spoken = (r) => r.response.outputSpeech && r.response.outputSpeech.text;

test('"ask hermes what\'s on my plate": the carrier word is put back and the answer is spoken inline', async () => {
    reset();
    const ctx = ctxWith();
    const r = await handle(intent('AskWhatsIntent', 'on my plate today'), ctx);
    assert.deepEqual(ctx.asked, ["what's on my plate today"]);
    assert.equal(spoken(r), 'You have two meetings today.');
    assert.equal(r.response.shouldEndSession, true, 'a plain answer ends the session: say "continue" to add to it');
    assert.match(r.sessionAttributes.conv, /^alexa-/);
});

test('Hermes ends on a question: the Echo keeps listening, and your reply goes to the same conversation', async () => {
    reset();
    const asked = [];
    const ctx = ctxWith({ askHermes: async (t, o) => (asked.push([t, o.session]), asked.length === 1 ? 'Which account, work or personal?' : 'Done. Sent from work.') });
    const r1 = await handle(intent('AskSendIntent', 'the report to Rohan'), ctx);
    assert.equal(r1.response.shouldEndSession, false);
    assert.ok(r1.response.reprompt);
    const conv = r1.sessionAttributes.conv;
    // the reply arrives in the same Alexa session: the session attribute names the conversation
    const r2 = await handle({ session: { attributes: { conv } }, ...intent('AskFillerIntent', 'work one') }, ctx);
    assert.equal(asked[1][1], conv, 'same Hermes session');
    assert.equal(spoken(r2), 'Done. Sent from work.');
    assert.equal(r2.response.shouldEndSession, true);
    // yes / no go to Hermes while it waits for you
    const r3 = await handle({ session: { attributes: { conv } }, request: { type: 'IntentRequest', intent: { name: 'AMAZON.YesIntent' } } }, ctx);
    assert.equal(asked[2][0], 'Yes.');
    assert.equal(asked[2][1], conv);
});

test('listen setting: "always" keeps listening, "never" never does', async () => {
    reset();
    const always = ctxWith({ config: { skill: { applicationId: APP, listen: 'always' } } });
    assert.equal((await handle(intent('AskWhatIntent', 'is up'), always)).response.shouldEndSession, false);
    const never = ctxWith({ askHermes: async () => 'Which one?', config: { skill: { applicationId: APP, listen: 'never' } } });
    assert.equal((await handle(intent('AskWhatIntent', 'is up'), never)).response.shouldEndSession, true);
});

test('continue / follow up: the last conversation goes on, the carrier word is dropped, a fresh ask starts a new one', async () => {
    reset();
    const calls = [];
    const ctx = () => ctxWith({ askHermes: async (t, o) => (calls.push([t, o.session]), 'Okay.') });
    await handle(intent('AskWhatIntent', 'is on my calendar'), ctx());
    const first = calls[0][1];
    clock += 60_000;
    await handle(intent('AskContinueIntent', 'and move the ten o clock to noon'), ctx());
    assert.deepEqual(calls[1], ['and move the ten o clock to noon', first], 'same Hermes session, no "continue" in the question');
    await handle(intent('AskFollowUpIntent', 'who is it with'), ctx());
    assert.equal(calls[2][1], first);
    await handle(intent('AskTellIntent', 'more'), ctx());
    assert.equal(calls[3][1], first, '"tell me more" continues too');
    await handle(intent('AskHowIntent', 'is the weather'), ctx());
    assert.notEqual(calls[4][1], first, 'a plain question starts a new conversation');
    // and "continue" now means that new one
    await handle(intent('AskContinueIntent', 'in Delhi'), ctx());
    assert.equal(calls[5][1], calls[4][1]);
});

test('"continue" alone opens the last conversation and listens; with nothing recent it says so; old ones are not resumed', async () => {
    reset();
    const calls = [];
    const ctx = () => ctxWith({ askHermes: async (t, o) => (calls.push(o.session), 'Okay.') });
    assert.match(spoken(await handle(intent('AskContinueIntent'), ctx())), /don't have a recent conversation/);
    await handle(intent('AskWhatIntent', 'is on my calendar'), ctx());
    const r = await handle(intent('AskContinueIntent'), ctx());
    assert.equal(r.response.shouldEndSession, false);
    assert.match(spoken(r), /picking up where we left off.*calendar/);
    assert.equal(r.sessionAttributes.conv, calls[0]);
    // 13 hours later the conversation is too old: a new one starts and you are told
    clock += 13 * 3600_000;
    const old = await handle(intent('AskContinueIntent', 'and tomorrow'), ctx());
    assert.notEqual(calls[1], calls[0]);
    assert.match(spoken(old), /too old/);
});

test('start over forgets the conversation; each profile keeps its own', async () => {
    reset();
    const calls = [];
    const as = (profile) => ctxWith({ profile, askHermes: async (t, o) => (calls.push([profile, o.session]), 'Okay.') });
    await handle(intent('AskWhatIntent', 'a'), as('sally'));
    await handle(intent('AskWhatIntent', 'b'), as('eddie'));
    await handle(intent('AskContinueIntent', 'c'), as('sally'));
    assert.equal(calls[2][1], calls[0][1]);
    assert.notEqual(calls[2][1], calls[1][1]);
    const r = await handle(intent('NewChatIntent'), as('sally'));
    assert.deepEqual(r.sessionAttributes, {});
    assert.match(spoken(await handle(intent('AskContinueIntent'), as('sally'))), /don't have a recent conversation/);
    assert.match(spoken(await handle(intent('AskContinueIntent'), as('eddie'))), /picking up/);
});

test('music mode: an answer in time is said in Alexa\'s own voice (no stream, so Bluetooth stays); a slow one becomes a stream unless music mode is on', async () => {
    reset();
    const log = [];
    const voice = (result) => ({
        start: (q, o) => (log.push(['start', q, o.session, o.defer]), { id: 'v1' }),
        settle: async () => result,
        discard: (id) => log.push(['discard', id]),
        promote: (id) => log.push(['promote', id]),
    });
    const base = { voiceUrl: (id) => `https://skill.example/voice/SECRET/${id}.mp3` };
    // fast: spoken, never a stream
    let r = await handle(intent('AskWhatIntent', 'is up'), ctxWith({ ...base, voice: voice({ answer: 'Two meetings today.' }) }));
    assert.equal(spoken(r), 'Two meetings today.');
    assert.equal(r.response.directives, undefined, 'no AudioPlayer: Bluetooth music is not interrupted');
    assert.deepEqual(log.map((l) => l[0]), ['start', 'discard']);
    assert.equal(log[0][3], true, 'speech is held back until we know it is a stream');
    // slow: the stream takes over
    log.length = 0;
    r = await handle(intent('AskWhatIntent', 'is up'), ctxWith({ ...base, voice: voice(null) }));
    assert.equal(r.response.directives[0].type, 'AudioPlayer.Play');
    assert.deepEqual(log.map((l) => l[0]), ['start', 'promote']);
    // slow with music mode on: no stream, the answer is kept
    assert.match(spoken(await handle(intent('MusicModeOnIntent'), ctxWith())), /Music mode is on/);
    assert.equal(state.readPrefs().musicMode, true);
    log.length = 0;
    r = await handle(intent('AskWhatIntent', 'is up'), ctxWith({ ...base, voice: voice(null) }));
    assert.equal(r.response.directives, undefined);
    assert.match(spoken(r), /On it.*give me the answer/);
    assert.equal(r.response.shouldEndSession, false, 'the session stays open: "give me the answer" works right away');
    assert.ok(r.response.reprompt);
    assert.deepEqual(log.map((l) => l[0]), ['start'], 'never promoted');
    assert.match(spoken(await handle(intent('MusicModeOffIntent'), ctxWith())), /Music mode is off/);
    assert.equal(state.readPrefs().musicMode, false);
    // an inline failure is spoken plainly
    r = await handle(intent('AskWhatIntent', 'is up'), ctxWith({ ...base, voice: voice({ error: { spoken: 'Something went wrong with Hermes.' } }) }));
    assert.equal(spoken(r), 'Something went wrong with Hermes.');
});

test('conversation can be turned off', async () => {
    const ctx = ctxWith({ config: { skill: { applicationId: APP, conversation: false } } });
    const r = await handle(intent('AskCanIntent', 'check my calendar'), ctx);
    assert.deepEqual(ctx.asked, ['can you check my calendar']);
    assert.equal(r.response.shouldEndSession, true);
});

test('slow Hermes without the voice stream: confirms inside the time limit and keeps the answer for "give me the answer"', async () => {
    reset();
    const ctx = ctxWith({ askHermes: () => new Promise((res) => setTimeout(() => res('Done. Booked it.'), 200)) });
    const t0 = Date.now();
    const r = await handle(intent('AskRemindIntent', 'to call Rohan at five'), ctx);
    assert.ok(Date.now() - t0 < 150, 'answered Alexa quickly');
    assert.match(spoken(r), /On it/);
    assert.equal(r.response.shouldEndSession, true);
    assert.equal(state.readPending().status, 'working');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(state.readPending().status, 'ready');
    assert.equal(spoken(await handle(intent('LastAnswerIntent'), ctx)), 'Done. Booked it.');
});

test('Hermes failing is spoken, not thrown; a late failure is kept as a sorry', async () => {
    reset();
    const quick = ctxWith({ askHermes: async () => { throw new Error('ssh down'); } });
    assert.match(spoken(await handle(intent('AskHowIntent', 'is the weather'), quick)), /Something went wrong with Hermes/);

    const late = ctxWith({ askHermes: () => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 150)) });
    await handle(intent('AskHowIntent', 'is the weather'), late);
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(state.readPending().answer, "Sorry, Hermes didn't answer.");
});

test('empty query, launch, help, fallback keep the session open with a prompt', async () => {
    const ctx = ctxWith();
    for (const r of [await handle(intent('AskWhatIntent'), ctx), await handle({ request: { type: 'LaunchRequest' } }, ctx), await handle(intent('AMAZON.HelpIntent'), ctx), await handle(intent('AMAZON.FallbackIntent'), ctx)]) {
        assert.equal(r.response.shouldEndSession, false);
        assert.ok(r.response.reprompt);
    }
    assert.deepEqual(ctx.asked, []);
});

test('ring from a Routine (no engine request): plays the default sound itself; with no sound it says so', async () => {
    reset();
    assert.match(spoken(await handle(intent('RingAlarmIntent'), ctxWith())), /don't have an alarm sound/i);

    const ctx = ctxWith({ defaultSound: () => 'alarm.mp3' });
    const r = await handle(intent('RingAlarmIntent'), ctx);
    const d = r.response.directives[0];
    assert.equal(d.type, 'AudioPlayer.Play');
    assert.deepEqual(parseToken(d.audioItem.stream.token), { id: 'routine', n: 0 });
    assert.equal(state.readRequest().active, true);

    // loops until the time limit, then stops by itself
    clock += 10 * 60 * 1000;
    const loop = await handle({ request: { type: 'AudioPlayer.PlaybackNearlyFinished', token: d.audioItem.stream.token } }, ctx);
    assert.equal(loop.response.directives[0].playBehavior, 'ENQUEUE');
    clock += 21 * 60 * 1000;
    const done = await handle({ request: { type: 'AudioPlayer.PlaybackNearlyFinished', token: d.audioItem.stream.token } }, ctx);
    assert.deepEqual(done.response, {}, '30 minute limit');
    assert.equal(state.readRequest().active, false);

    // "stop" ends a routine ring right away
    await handle(intent('RingAlarmIntent'), ctx);
    await handle(intent('AMAZON.StopIntent'), ctx);
    assert.equal(state.readRequest().active, false);
});

test('ring: a stale engine request is replaced by a fresh routine ring', async () => {
    reset();
    state.requestRing({ id: 'a1', file: 'old.mp3', now: clock - 10 * 60 * 1000 });
    const r = await handle(intent('RingAlarmIntent'), ctxWith({ defaultSound: () => 'alarm.mp3' }));
    assert.equal(r.response.directives[0].audioItem.stream.url, 'https://skill.example/audio/SECRET/alarm.mp3');
});

test('ring: plays the file with AudioPlayer; nearly-finished queues it again until the engine says stop', async () => {
    reset();
    state.requestRing({ id: 'a1', file: 'alarm.mp3', now: clock });
    const ctx = ctxWith();

    const r = await handle(intent('RingAlarmIntent'), ctx);
    const d = r.response.directives[0];
    assert.equal(d.type, 'AudioPlayer.Play');
    assert.equal(d.playBehavior, 'REPLACE_ALL');
    assert.equal(d.audioItem.stream.url, 'https://skill.example/audio/SECRET/alarm.mp3');
    assert.deepEqual(parseToken(d.audioItem.stream.token), { id: 'a1', n: 0 });

    const near = await handle({ request: { type: 'AudioPlayer.PlaybackNearlyFinished', token: d.audioItem.stream.token } }, ctx);
    const q = near.response.directives[0];
    assert.equal(q.playBehavior, 'ENQUEUE');
    assert.equal(q.audioItem.stream.expectedPreviousToken, d.audioItem.stream.token);
    assert.deepEqual(parseToken(q.audioItem.stream.token), { id: 'a1', n: 1 });

    state.endRing(clock);
    const after = await handle({ request: { type: 'AudioPlayer.PlaybackNearlyFinished', token: q.audioItem.stream.token } }, ctx);
    assert.deepEqual(after.response, {}, 'engine stopped the alarm: the loop ends');
});

test('Echo events are recorded for the engine: started, stopped, failed; foreign audio is ignored', async () => {
    reset();
    const t0 = clock;
    state.requestRing({ id: 'a1', file: 'alarm.mp3', now: clock });
    const ctx = ctxWith();
    const tok = 'alarm|a1|0';
    await handle({ request: { type: 'AudioPlayer.PlaybackStarted', token: tok } }, ctx);
    let ev = state.readEvents();
    assert.equal(ev.lastEvent, 'started');
    assert.equal(ev.startedAt, t0);

    clock += 5000;
    await handle({ request: { type: 'AudioPlayer.PlaybackStarted', token: 'alarm|a1|1' } }, ctx);
    assert.equal(state.readEvents().startedAt, t0, 'startedAt keeps its first value');

    clock += 5000;
    await handle({ request: { type: 'AudioPlayer.PlaybackStopped', token: tok } }, ctx);
    ev = state.readEvents();
    assert.equal(ev.lastEvent, 'stopped');
    assert.equal(ev.stoppedAt, clock);

    await handle({ request: { type: 'AudioPlayer.PlaybackFailed', token: tok, error: { type: 'MEDIA_ERROR_UNKNOWN' } } }, ctx);
    assert.ok(state.readEvents().failedAt);
    assert.ok(ctx.logs.some((l) => /alarm audio failed/.test(l)));

    const before = JSON.stringify(state.readEvents());
    await handle({ request: { type: 'AudioPlayer.PlaybackStopped', token: 'somebody-elses-audio' } }, ctx);
    assert.equal(JSON.stringify(state.readEvents()), before);
});

test('"Alexa, stop" while ringing is recorded as you being awake and stops the audio', async () => {
    reset();
    state.requestRing({ id: 'a1', file: 'alarm.mp3', now: clock });
    const r = await handle(intent('AMAZON.StopIntent'), ctxWith());
    assert.deepEqual(r.response.directives, [{ type: 'AudioPlayer.Stop' }]);
    assert.equal(state.readEvents().userStoppedAt, clock);
});

test('"stop" when nothing is ringing just stops audio quietly and records nothing', async () => {
    reset();
    state.requestRing({ id: 'a1', file: 'alarm.mp3', now: clock });
    state.endRing(clock);
    const r = await handle(intent('AMAZON.StopIntent'), ctxWith());
    assert.deepEqual(r.response.directives, [{ type: 'AudioPlayer.Stop' }]);
    assert.equal(r.response.outputSpeech, undefined);
    assert.equal(state.readEvents().userStoppedAt, undefined);
});

test('interaction model matches the handlers and respects Alexa rules', () => {
    const m = buildModel('hermes').interactionModel.languageModel;
    assert.equal(m.invocationName, 'hermes');
    const names = m.intents.map((i) => i.name);
    assert.equal(new Set(names).size, names.length, 'unique intent names');
    for (const n of Object.keys(QUERY_INTENTS)) assert.ok(names.includes(n));
    for (const i of m.intents.filter((x) => QUERY_INTENTS[x.name])) {
        assert.deepEqual(i.slots, [{ name: 'query', type: 'AMAZON.SearchQuery' }]);
        // "continue" / "follow up" alone are fine too: they carry no slot
        for (const s of i.samples) assert.ok(/^[^{]+\{query\}$/.test(s) || (QUERY_INTENTS[i.name].resume && !s.includes('{')), `SearchQuery needs a carrier phrase before it: ${s}`);
    }
    assert.deepEqual(m.intents.find((i) => i.name === 'RingAlarmIntent').samples, RING_SAMPLES);
    // Alexa rejects the build ("total number of slots and intents ... exceeds the limit of 350") above this.
    const { sizeOf, ALEXA_LIMIT } = require('../src/gen-model');
    assert.ok(sizeOf(buildModel('hermes')) <= ALEXA_LIMIT - 10, `intents + slots = ${sizeOf(buildModel('hermes'))}, Alexa's limit is ${ALEXA_LIMIT}`);
    const extra = buildModel('hermes', { extraPhrases: { RingAlarmIntent: ['wake me up'] } }).interactionModel.languageModel.intents.find((i) => i.name === 'RingAlarmIntent');
    assert.ok(!extra.samples.includes('wake me up'), '"wake" is an opening word of free-form questions, so the phrase is refused');
    const { checkExtra } = require('../src/gen-model');
    assert.equal(checkExtra({ RingAlarmIntent: ['wake me up'] }).rejected.length, 1);
    const good = buildModel('hermes', { extraPhrases: { RingAlarmIntent: ['ring my wake up alarm'], TestHermesIntent: ['test my cloud server'] } }).interactionModel.languageModel.intents;
    assert.ok(good.find((i) => i.name === 'RingAlarmIntent').samples.includes('ring my wake up alarm'));
    assert.ok(good.find((i) => i.name === 'TestHermesIntent').samples.includes('test my cloud server'));
    // "ring the alarm" must hit RingAlarmIntent, and no query intent may start with a bare "to"
    assert.ok(!Object.values(QUERY_INTENTS).some((q) => q.samples.some((s) => s.startsWith('to '))));
});

test('the shared filler intent hands everything after the dropped word to Hermes; meaningful words are put back', async () => {
    const asked = [];
    const ctx = ctxWith({ askHermes: async (t) => (asked.push(t), 'ok') });
    const q = (name, v) => ({ version: '1.0', request: { type: 'IntentRequest', intent: { name, slots: { query: { name: 'query', value: v } } } } });
    await handle(q('AskFillerIntent', 'latest emails'), ctx);
    await handle(q('AskSendIntent', 'a mail to Rohan'), ctx);
    assert.deepEqual(asked, ['latest emails', 'send a mail to Rohan']);
});

// ---- HTTP server ----

function listen(opts) {
    const server = createServer({ config: { skill: { applicationId: APP } }, askHermes: async () => 'hi there', say: async () => {}, log: () => {}, ...opts });
    return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}
function call(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end(body);
    });
}
const envelope = (appId = APP, body = intent('AskWhatIntent', 'time is it')) => JSON.stringify({ session: { application: { applicationId: appId } }, ...body });

test('server: signature + skill id are enforced; a valid request gets Hermes\'s answer', async () => {
    reset();
    let verified = 0;
    const { server, port } = await listen({ verify: async () => void verified++ });
    try {
        const ok = await call(port, { method: 'POST', path: '/alexa', body: envelope() });
        assert.equal(ok.status, 200);
        assert.equal(JSON.parse(ok.body).response.outputSpeech.text, 'hi there');
        assert.equal(verified, 1);

        const foreign = await call(port, { method: 'POST', path: '/alexa', body: envelope('amzn1.ask.skill.someone-else') });
        assert.equal(foreign.status, 403, "another developer's skill cannot use your Hermes");

        const noId = await listen({ config: { skill: {} }, verify: async () => {} });
        assert.equal((await call(noId.port, { method: 'POST', path: '/alexa', body: envelope() })).status, 403, 'no configured skill id: refuse everything');
        noId.server.close();
    } finally {
        server.close();
    }

    const bad = await listen({ verify: async () => { throw new Error('invalid signature'); } });
    try {
        assert.equal((await call(bad.port, { method: 'POST', path: '/alexa', body: envelope() })).status, 400);
    } finally {
        bad.server.close();
    }
});

test('server: handler crash returns a spoken apology instead of an error', async () => {
    const { server, port } = await listen({ insecure: true, askHermes: () => { throw new Error('boom'); } });
    try {
        const r = await call(port, { method: 'POST', path: '/alexa', body: envelope() });
        assert.equal(r.status, 200);
        assert.match(JSON.parse(r.body).response.outputSpeech.text, /Something went wrong/);
    } finally {
        server.close();
    }
});

test('server: audio needs the secret, supports Range (Alexa seeks), and cannot escape its folder', async () => {
    const { audioSecret } = require('../src/server');
    const secret = audioSecret({ skill: {} });
    const { server, port } = await listen({});
    try {
        const full = await call(port, { path: `/audio/${secret}/alarm.mp3` });
        assert.equal(full.status, 200);
        assert.equal(full.headers['content-type'], 'audio/mpeg');
        assert.deepEqual(full.body, AUDIO);

        const part = await call(port, { path: `/audio/${secret}/alarm.mp3`, headers: { Range: 'bytes=100-199' } });
        assert.equal(part.status, 206);
        assert.equal(part.headers['content-range'], 'bytes 100-199/5000');
        assert.deepEqual(part.body, AUDIO.subarray(100, 200));

        const tail = await call(port, { path: `/audio/${secret}/alarm.mp3`, headers: { Range: 'bytes=4990-' } });
        assert.deepEqual(tail.body, AUDIO.subarray(4990));

        assert.equal((await call(port, { path: `/audio/wrong-secret/alarm.mp3` })).status, 404);
        assert.equal((await call(port, { path: `/audio/${secret}/missing.mp3` })).status, 404);
        const sneaky = await call(port, { path: `/audio/${secret}/..%2Foutside.mp3` });
        assert.equal(sneaky.status === 200 ? sneaky.body.toString() : 'blocked', 'blocked', 'a file outside the audio folder must not be served');
        assert.equal((await call(port, { path: `/audio/${secret}/alarm.txt` })).status, 404);
        assert.equal((await call(port, { path: '/health' })).body.toString(), 'ok');
    } finally {
        server.close();
    }
});

test('with spoken answers on: a question starts the stream and plays it, no waiting for "give me the answer"', async () => {
    reset();
    const started = [];
    const ctx = ctxWith({
        voice: { start: (q) => (started.push(q), { id: 'abc123' }) },
        voiceUrl: (id) => `https://skill.example/voice/SECRET/${id}.mp3`,
    });
    const r = await handle(intent('AskWhatIntent', 'is on my plate'), ctx);
    assert.deepEqual(started, ["what is on my plate"]);
    const d = r.response.directives[0];
    assert.equal(d.type, 'AudioPlayer.Play');
    assert.equal(d.audioItem.stream.url, 'https://skill.example/voice/SECRET/abc123.mp3');
    assert.equal(d.audioItem.stream.token, 'voice|abc123');
    assert.equal(r.response.shouldEndSession, true);
    assert.equal(r.response.outputSpeech, undefined, 'the stream does the talking');
    assert.deepEqual(ctx.asked, [], 'the old ask-and-wait path is not used');
});

// ---- long tasks, profiles, health, yolo ----

test('no plain-command sample starts with a question carrier word (Alexa could not tell them apart)', () => {
    const { PLAIN_INTENTS } = require('../src/handlers');
    const carriers = Object.values(QUERY_INTENTS).map((q) => q.samples[0].replace(' {query}', '').trim()).filter(Boolean);
    for (const [name, samples] of Object.entries(PLAIN_INTENTS)) {
        for (const s of samples) {
            for (const c of carriers) assert.ok(!(s === c || s.startsWith(`${c} `)), `"${s}" (${name}) starts with the carrier "${c}"`);
            assert.ok(!/^(stop|cancel|pause|help|yes|no)$/.test(s), `"${s}" is a built-in intent`);
        }
    }
    const all = Object.values(PLAIN_INTENTS).flat();
    assert.equal(new Set(all).size, all.length, 'a phrase belongs to one intent');
});

test('"any update" while Hermes is still going: says how long and the latest step; ready answers are read once', async () => {
    reset();
    const ctx = ctxWith();
    // still on the line: the session stays open so you can ask again in a few seconds
    state.writePending({ status: 'working', question: 'q', startedAt: clock - 5000, conv: 'alexa-x' });
    const live = await handle(intent('LastAnswerIntent'), ctx);
    assert.match(spoken(live), /Still working/);
    assert.equal(live.response.shouldEndSession, false);
    assert.equal(live.sessionAttributes.conv, 'alexa-x');
    // handed off to the background: says it will message you, and lets go
    state.writePending({ status: 'working', question: 'q', background: true, startedAt: clock - 3 * 60000, progress: [{ text: 'Searching the web' }, { text: 'Reading the report' }] });
    const t = spoken(await handle(intent('LastAnswerIntent'), ctx));
    assert.match(t, /3 minutes/);
    assert.match(t, /Reading the report/);
    assert.match(t, /message you/);
    state.writePending({ status: 'ready', question: 'q', answer: 'All done.', startedAt: clock, readyAt: clock });
    assert.equal(spoken(await handle(intent('LastAnswerIntent'), ctx)), 'All done.');
    assert.match(spoken(await handle(intent('LastAnswerIntent'), ctx)), /nothing waiting/);
});

test('cancel the task stops the running Hermes call; with none running it says so', async () => {
    let n = 0;
    const ctx = ctxWith({ voice: { cancel: () => ++n === 1 } });
    assert.match(spoken(await handle(intent('CancelTaskIntent'), ctx)), /stopped/);
    assert.match(spoken(await handle(intent('CancelTaskIntent'), ctx)), /nothing running/);
    assert.match(spoken(await handle(intent('CancelTaskIntent'), ctxWith())), /nothing running/);
});

test('test the server / server health are instant checks that never ask Hermes', async () => {
    const ctx = ctxWith({ health: { test: async () => ({ spoken: 'Azure is up.' }), report: async () => ({ spoken: 'Everything is working.' }) } });
    assert.equal(spoken(await handle(intent('TestServerIntent'), ctx)), 'Azure is up.');
    assert.equal(spoken(await handle(intent('HealthIntent'), ctx)), 'Everything is working.');
    assert.deepEqual(ctx.asked, []);
    const broken = ctxWith({ health: { test: async () => { throw new Error('boom'); } } });
    assert.match(spoken(await handle(intent('TestServerIntent'), broken)), /couldn't run/);
    assert.match(spoken(await handle(intent('HealthIntent'), ctxWith())), /not set up/);
});

test('yolo on / off / status by voice', async () => {
    let on = false;
    const ctx = ctxWith({ yolo: { isOn: () => on, set: (v) => (on = v) } });
    assert.match(spoken(await handle(intent('YoloOnIntent'), ctx)), /Yolo mode is on/);
    assert.equal(on, true);
    assert.match(spoken(await handle(intent('YoloStatusIntent'), ctx)), /is on/);
    assert.match(spoken(await handle(intent('YoloOffIntent'), ctx)), /off/);
    assert.equal(on, false);
    assert.match(spoken(await handle(intent('YoloStatusIntent'), ctx)), /is off/);
});

test('a profile skill ("ask Sally") sends the profile along; a finished background task is announced first', async () => {
    reset();
    const calls = [];
    const ctx = ctxWith({
        profile: 'sally',
        voice: { start: (q, o) => (calls.push([q, o]), { id: 'abc' }) },
        voiceUrl: (id) => `https://skill.example/voice/SECRET/${id}.mp3`,
    });
    state.writePending({ status: 'ready', question: 'old', answer: 'The report is ready.', background: true, startedAt: clock - 60000, readyAt: clock - 1000 });
    await handle(intent('AskWhatIntent', 'is next'), ctx);
    assert.equal(calls[0][1].profile, 'sally');
    assert.match(calls[0][1].preface, /earlier task finished.*The report is ready/);
    // a plain (non-background) pending answer is not announced
    state.writePending({ status: 'ready', question: 'old', answer: 'x', startedAt: clock, readyAt: clock });
    await handle(intent('AskWhatIntent', 'is next'), ctx);
    assert.equal(calls[1][1].preface, undefined);

    // text path passes the profile to Hermes too
    const asked = [];
    const t = ctxWith({ profile: 'eddie', askHermes: async (q, o) => (asked.push([q, o]), 'ok ok') });
    await handle(intent('AskWhatIntent', 'time is it'), t);
    assert.equal(asked[0][1].profile, 'eddie');
    assert.match(asked[0][1].session, /^alexa-/);
});

test('server: every profile skill id is accepted, others are refused, and the profile reaches the handler', async () => {
    reset();
    const seen = [];
    const { server, port } = await listen({
        config: { skill: { applicationId: APP, profiles: { 'amzn1.ask.skill.sally': 'sally' } } },
        verify: async () => {},
        askHermes: async (q, o) => (seen.push(o), 'hi there'),
    });
    try {
        const post = (id) => call(port, { method: 'POST', path: '/alexa', body: envelope(id) });
        assert.equal((await post('amzn1.ask.skill.sally')).status, 200);
        assert.equal((await post(APP)).status, 200);
        assert.equal((await post('amzn1.ask.skill.other')).status, 403);
        assert.deepEqual(seen.map((o) => o.profile), ['sally', undefined]);
    } finally {
        server.close();
    }
});

test('"update hermes" starts a live job; test bridge / hermes call their own check; no voice means a plain refusal', async () => {
    reset();
    const jobs = [];
    const ctx = ctxWith({
        voice: { startJob: (label, run) => (jobs.push([label, run]), { id: 'job1' }) },
        voiceUrl: (id) => `https://skill.example/voice/SECRET/${id}.mp3`,
        health: { updateHermes: async (h) => `done ${typeof h.say}`, testBridge: async () => ({ spoken: 'Bridge ok.' }), testHermes: async () => ({ spoken: 'Hermes ok.' }) },
    });
    const r = await handle(intent('UpdateHermesIntent'), ctx);
    assert.equal(r.response.directives[0].audioItem.stream.token, 'voice|job1');
    assert.equal(jobs[0][0], 'update Hermes');
    assert.equal(await jobs[0][1]({ say() {} }), 'done function');
    assert.equal(spoken(await handle(intent('TestBridgeIntent'), ctx)), 'Bridge ok.');
    assert.equal(spoken(await handle(intent('TestHermesIntent'), ctx)), 'Hermes ok.');
    assert.match(spoken(await handle(intent('UpdateHermesIntent'), ctxWith())), /can't update Hermes/);
});
