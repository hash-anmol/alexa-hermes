'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createVoice, takeSentences, progressPhrase } = require('../src/voice');

// ---- fakes: audio is plain bytes that say what they are ----
const audio = {
    chime: () => Buffer.alloc(120, 'c'),
    silence: () => Buffer.alloc(3000, 's'), // half a second at 6000 bytes/s
    speak: async (text) => Buffer.from(`S${text}~`),
};
const kind = (b) => (b[0] === 0x63 ? 'chime' : b[0] === 0x73 ? 'silence' : b.toString().slice(1, -1));
const speech = (res) => res.writes.map(kind).filter((k) => k !== 'chime' && k !== 'silence');

function fakeRes() {
    const res = { writes: [], ended: false, head: null, closers: [] };
    res.writeHead = (code, h) => (res.head = { code, h });
    res.write = (b) => res.writes.push(b);
    res.end = () => (res.ended = true);
    res.on = (ev, fn) => ev === 'close' && res.closers.push(fn);
    res.hangUp = () => res.closers.forEach((f) => f());
    return res;
}
const fakeState = () => {
    const s = { pending: null, cleared: 0 };
    s.writePending = (p) => (s.pending = p);
    s.clearPending = () => ((s.pending = null), s.cleared++);
    return s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GET = { method: 'GET' };

function setup(streamHermes, config = {}) {
    const state = fakeState();
    const voice = createVoice({ audio, streamHermes, state, config, tickMs: 15, log: () => {} });
    return { voice, state };
}

test('takeSentences: only finished sentences, short pieces glued, decimals kept, final flush', () => {
    let r = takeSentences('It is Monday, November nine. And the weat');
    assert.deepEqual(r.sentences, ['It is Monday, November nine.']);
    assert.equal(r.rest, 'And the weat');

    r = takeSentences('Dr. Rao says 3.5 million people came. Then');
    assert.deepEqual(r.sentences, ['Dr. Rao says 3.5 million people came.']);

    r = takeSentences('Two meetings today. ');
    assert.deepEqual(r.sentences, [], 'under 25 characters waits for more');
    r = takeSentences('Two meetings today.', true);
    assert.deepEqual(r.sentences, ['Two meetings today.']);
    assert.equal(r.rest, '');

    const long = 'word, '.repeat(80);
    r = takeSentences(long);
    assert.ok(r.sentences.length === 1 && r.sentences[0].length <= 281 && r.rest.length > 0, 'an unbroken run is cut at a comma');
});

test('progressPhrase', () => {
    assert.equal(progressPhrase('web_search'), 'Searching the web.');
    assert.equal(progressPhrase('terminal'), 'Running a command.');
    assert.equal(progressPhrase('google_calendar_list'), 'Checking your calendar.');
    assert.equal(progressPhrase('mystery'), 'Working on it.');
});

test('stream: chime first, silence while Hermes thinks, progress line, answer sentence by sentence, then the stream ends', async () => {
    const { voice, state } = setup(async (q, on) => {
        assert.equal(q, 'what is on my plate');
        await sleep(120);
        on({ type: 'tool_use', name: 'terminal' });
        await sleep(40);
        for (const t of ['You have two meetings today. ', 'The first is at ten, ', 'with Rohan at the office. ', 'Then a call at four.']) {
            on({ type: 'text', text: t });
            await sleep(10);
        }
        return { text: 'You have two meetings today. The first is at ten, with Rohan at the office. Then a call at four.' };
    });
    const { id } = voice.start('what is on my plate');
    assert.deepEqual(state.pending && state.pending.status, 'working');

    const res = fakeRes();
    assert.ok(voice.attach(id, GET, res));
    assert.equal(res.head.code, 200);
    assert.equal(res.head.h['Content-Type'], 'audio/mpeg');
    assert.equal(kind(res.writes[0]), 'chime', 'the first thing you hear is the chime');

    await sleep(500);
    assert.ok(res.writes.filter((b) => kind(b) === 'silence').length >= 2, 'silence keeps the stream alive');
    assert.ok(res.ended, 'stream ended after the last sentence');
    assert.deepEqual(speech(res), ['Running a command.', 'You have two meetings today.', 'The first is at ten, with Rohan at the office.', 'Then a call at four.']);
    assert.equal(state.pending, null, 'delivered: nothing is waiting for "give me the answer"');
});

test('"One moment." if Hermes has said nothing for 3 seconds; no narration when switched off', async () => {
    const slow = setup(async () => {
        await sleep(3300);
        return { text: 'Done and dusted, all good here.' };
    });
    const r1 = fakeRes();
    slow.voice.attach(slow.voice.start('x').id, GET, r1);
    await sleep(3600);
    assert.ok(speech(r1).includes('One moment.'));

    const quiet = setup(async (q, on) => {
        on({ type: 'tool_use', name: 'terminal' });
        return { text: 'Just the answer, nothing else here.' };
    }, { skill: { speech: { narrate: false } } });
    const r2 = fakeRes();
    quiet.voice.attach(quiet.voice.start('x').id, GET, r2);
    await sleep(200);
    assert.deepEqual(speech(r2), ['Just the answer, nothing else here.']);
});

test('only the result event (nothing streamed): the answer is still spoken', async () => {
    const { voice } = setup(async () => ({ text: 'It is nine fifteen in the evening. Goodnight soon.' }));
    const res = fakeRes();
    voice.attach(voice.start('x').id, GET, res);
    await sleep(150);
    assert.deepEqual(speech(res), ['It is nine fifteen in the evening.', 'Goodnight soon.']);
});

test('listener hung up (Alexa, stop): the answer is kept for "give me the answer"', async () => {
    const { voice, state } = setup(async (q, on) => {
        await sleep(100);
        on({ type: 'text', text: 'The answer you wanted is forty two.' });
        return { text: 'The answer you wanted is forty two.' };
    });
    const res = fakeRes();
    voice.attach(voice.start('x').id, GET, res);
    await sleep(30);
    res.hangUp();
    await sleep(250);
    assert.equal(state.pending.status, 'ready');
    assert.equal(state.pending.answer, 'The answer you wanted is forty two.');
});

test('Echo connects after Hermes is done: it still gets the whole answer, then the end', async () => {
    const { voice, state } = setup(async () => ({ text: 'Everything is fine with the server today.' }));
    const { id } = voice.start('x');
    await sleep(100);
    assert.equal(state.pending.status, 'ready', 'nobody was listening yet, so it is also kept');
    const res = fakeRes();
    voice.attach(id, GET, res);
    assert.deepEqual(speech(res), ['Everything is fine with the server today.']);
    assert.ok(res.ended);
});

test('Hermes failing is spoken; nothing stale is kept', async () => {
    const { voice, state } = setup(async () => {
        throw new Error('Connection timed out');
    });
    const res = fakeRes();
    voice.attach(voice.start('x').id, GET, res);
    await sleep(150);
    assert.deepEqual(speech(res), ["I can't reach Hermes. The machine may be off, or the network or VPN may be down."]);
    assert.equal(state.pending, null);
});

test('unknown stream id and HEAD requests', async () => {
    const { voice } = setup(async () => ({ text: 'ok ok ok ok ok ok ok ok ok ok' }));
    assert.equal(voice.attach('nope', GET, fakeRes()), false);
    const head = fakeRes();
    voice.attach(voice.start('x').id, { method: 'HEAD' }, head);
    assert.equal(head.head.code, 200);
    assert.deepEqual(head.writes, []);
    assert.ok(head.ended);
});

test("Hermes' own run timeout says it took too long", async () => {
    const { voice } = setup(async () => {
        throw new Error('timed out after 240000ms');
    });
    const res = fakeRes();
    voice.attach(voice.start('x').id, GET, res);
    await sleep(150);
    assert.deepEqual(speech(res), ['Hermes took too long, so I stopped it.']);
});

test('long silence before the first word: "Still on it." now and then, twice at most, never once the answer is talking', async () => {
    const { voice } = setup(async (q, on) => {
        await sleep(700);
        on({ type: 'text', text: 'Finally here is the answer for you. ' });
        await sleep(100);
        return { text: 'Finally here is the answer for you.' };
    }, { skill: { speech: { ackMs: 60000, stillMs: 100 } } });
    const res = fakeRes();
    voice.attach(voice.start('x').id, GET, res);
    await sleep(900);
    const said = speech(res);
    assert.equal(said.filter((t) => t === 'Still on it.').length, 2);
    assert.equal(said[said.length - 1], 'Finally here is the answer for you.');
});
