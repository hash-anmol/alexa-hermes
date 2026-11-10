'use strict';
// The Alexa skill's brain: takes an Alexa request envelope, returns the response JSON. No network here,
// so it is fully unit-testable. `ctx` brings the outside world:
//   ctx = { config, askHermes(text)->Promise<string>, voice (live spoken stream), health, yolo,
//           state (state.js), audioUrl(file)->https url, voiceUrl(id)->https url, now(), log(msg) }
//
// Jobs:
//   1. "Alexa, ask Hermes <anything>"  -> Hermes answers (spoken live as a stream, or as text when voice is not set up)
//   2. "ring the alarm"                -> plays the alarm mp3 on a loop with AudioPlayer until you say stop
//   3. health / test / update / yolo   -> instant checks that never touch the AI

const { explain } = require('./lib/errors');
const convo = require('./conversation');

// Alexa's SearchQuery slot needs a carrier word in every sample, and the carrier is cut off from the slot value.
// One intent per carrier lets us put the word back, so Hermes hears the whole sentence.
const QUERY_INTENTS = {
    AskWhatIntent: { prefix: 'what ', samples: ['what {query}'] },
    AskWhatsIntent: { prefix: "what's ", samples: ["what's {query}"] },
    AskHowIntent: { prefix: 'how ', samples: ['how {query}'] },
    AskWhenIntent: { prefix: 'when ', samples: ['when {query}'] },
    AskWhyIntent: { prefix: 'why ', samples: ['why {query}'] },
    AskWhoIntent: { prefix: 'who ', samples: ['who {query}'] },
    AskWhereIntent: { prefix: 'where ', samples: ['where {query}'] },
    AskIsIntent: { prefix: 'is ', samples: ['is {query}'] },
    AskDoIntent: { prefix: 'do ', samples: ['do {query}'] },
    AskCanIntent: { prefix: 'can you ', samples: ['can you {query}'] },
    AskTellIntent: { prefix: 'tell me ', samples: ['tell me {query}'] },
    AskAboutIntent: { prefix: 'about ', samples: ['about {query}'] },
    AskRemindIntent: { prefix: 'remind me ', samples: ['remind me {query}'] },
    AskSetIntent: { prefix: 'set ', samples: ['set {query}'] },
    AskAddIntent: { prefix: 'add ', samples: ['add {query}'] },
    AskCheckIntent: { prefix: 'check ', samples: ['check {query}'] },
    AskSearchIntent: { prefix: 'search ', samples: ['search {query}'] },
    AskPleaseIntent: { prefix: '', samples: ['please {query}'] },
    // "ask Hermes, continue <what you add>" / "follow up <what you add>": the last conversation goes on, with the carrier word dropped
    AskContinueIntent: { prefix: '', resume: true, samples: ['continue {query}', 'continue'] },
    AskFollowUpIntent: { prefix: '', resume: true, samples: ['follow up {query}', 'follow up'] },
};

const RING_SAMPLES = ['ring the alarm', 'start the alarm', 'play the alarm', 'ring my alarm'];
// None of these start with a word used by the query intents above, so Alexa can never confuse them.
const ANSWER_SAMPLES = ['give me the answer', 'any update', 'read me the answer', 'answer please', 'update me', 'status update', 'are you done', 'progress report'];
const CANCEL_SAMPLES = ['cancel the task', 'abort the task', 'never mind the task', 'cancel that task'];
const TEST_SAMPLES = ['test the server', 'test server', 'test the servers', 'ping the server', 'server test', 'test everything'];
const TEST_BRIDGE_SAMPLES = ['test the bridge', 'test my bridge', 'test the bridge server', 'ping the bridge', 'bridge test'];
const TEST_HERMES_SAMPLES = ['test the hermes server', 'test hermes server', 'test my hermes server', 'test hermes', 'ping hermes', 'hermes server test'];
const UPDATE_SAMPLES = ['update hermes', 'upgrade hermes', 'update the agent', 'update my agent', 'update hermes agent'];
const HEALTH_SAMPLES = ['server health', 'health report', 'health check', 'server status', 'system status', 'disk and memory'];
const YOLO_ON_SAMPLES = ['turn on yolo mode', 'yolo mode on', 'enable yolo mode', 'stop asking for permission', 'no more permission prompts'];
const YOLO_OFF_SAMPLES = ['turn off yolo mode', 'yolo mode off', 'disable yolo mode', 'ask for permission again', 'start asking for permission'];
const YOLO_STATUS_SAMPLES = ['yolo mode status', 'yolo status', 'yolo mode check'];
// Neither starts with an opening word of the free-form questions, so Alexa can never mistake them for one.
const NEW_CHAT_SAMPLES = ['start over', 'fresh start', 'different topic', 'change the subject', 'reset conversation'];
const MUSIC_ON_SAMPLES = ['music mode on', 'turn on music mode', 'enable music mode', 'protect my music', 'bluetooth mode on'];
const MUSIC_OFF_SAMPLES = ['music mode off', 'turn off music mode', 'disable music mode', 'bluetooth mode off'];
const PENDING_FRESH_MS = 30 * 60 * 1000;
const MAX_SPOKEN = 3000;
const RING_FRESH_MS = 2 * 60 * 1000; // a ring requested within the last 2 minutes is still the current one

const empty = () => ({ version: '1.0', response: {} });

// conv: the Hermes conversation to keep going if the session stays open (null: forget it)
function say(text, { end = true, reprompt, conv } = {}) {
    const response = { outputSpeech: { type: 'PlainText', text: String(text).slice(0, MAX_SPOKEN) }, shouldEndSession: end };
    if (!end && reprompt) response.reprompt = { outputSpeech: { type: 'PlainText', text: reprompt } };
    const out = { version: '1.0', response };
    if (conv) out.sessionAttributes = { conv };
    else if (conv === null) out.sessionAttributes = {};
    return out;
}

const play = (url, token, { enqueueAfter } = {}) => ({
    type: 'AudioPlayer.Play',
    playBehavior: enqueueAfter ? 'ENQUEUE' : 'REPLACE_ALL',
    audioItem: { stream: { token, url, offsetInMilliseconds: 0, ...(enqueueAfter ? { expectedPreviousToken: enqueueAfter } : {}) } },
});

const ringToken = (id, n) => `alarm|${id}|${n}`;
const parseToken = (t) => {
    const m = /^alarm\|(.+)\|(\d+)$/.exec(String(t || ''));
    return m ? { id: m[1], n: Number(m[2]) } : null;
};

function activeRing(ctx) {
    const rq = ctx.state.readRequest();
    return rq && rq.active ? rq : null;
}

// ---- alarm audio ----

// Two ways to get here: the alarm engine asked for a ring (fresh request), or an Alexa Routine said
// "ask hermes to ring the alarm" with no engine involved: then the skill rings the default sound itself.
function ring(ctx) {
    let rq = activeRing(ctx);
    if (!rq || ctx.now() - rq.requestedAt > RING_FRESH_MS) {
        const file = ctx.defaultSound && ctx.defaultSound();
        if (!file) return say("I don't have an alarm sound yet. Put an mp3 in the audio folder.");
        ctx.state.requestRing({ id: 'routine', file, now: ctx.now() });
        rq = ctx.state.readRequest();
    }
    ctx.state.recordEvent({ ringRequestedAt: ctx.now() });
    return {
        version: '1.0',
        response: { directives: [play(ctx.audioUrl(rq.file), ringToken(rq.id, 0))], shouldEndSession: true },
    };
}

function audioEvent(req, ctx) {
    const tok = parseToken(req.token);
    if (!tok) return empty(); // not our alarm audio
    const now = ctx.now();
    const rq = ctx.state.readRequest();
    switch (req.type) {
        case 'AudioPlayer.PlaybackStarted':
            ctx.state.recordEvent({ startedAt: now, lastEvent: 'started', lastEventAt: now }, { once: ['startedAt'] });
            return empty();
        case 'AudioPlayer.PlaybackStopped':
            ctx.state.recordEvent({ stoppedAt: now, lastEvent: 'stopped', lastEventAt: now });
            return empty();
        case 'AudioPlayer.PlaybackFinished':
            ctx.state.recordEvent({ lastEvent: 'finished', lastEventAt: now });
            return empty();
        case 'AudioPlayer.PlaybackFailed':
            ctx.state.recordEvent({ failedAt: now, error: req.error || null, lastEvent: 'failed', lastEventAt: now });
            ctx.log(`alarm audio failed: ${JSON.stringify(req.error || {})}`);
            return empty();
        case 'AudioPlayer.PlaybackNearlyFinished': {
            // Loop: queue the same file again for as long as the engine wants it to ring.
            if (!rq || !rq.active || rq.id !== tok.id) return empty();
            const maxMs = ((ctx.config.skill || {}).maxRingMinutes ?? 30) * 60 * 1000;
            if (now - rq.startedAt > maxMs) {
                ctx.state.endRing(now); // nobody stopped it for half an hour: stop looping
                return empty();
            }
            return {
                version: '1.0',
                response: { directives: [play(ctx.audioUrl(rq.file), ringToken(rq.id, tok.n + 1), { enqueueAfter: req.token })] },
            };
        }
        default:
            return empty();
    }
}

// "Alexa, stop" / pause while the alarm plays: that is you saying you're awake.
function stop(ctx) {
    if (activeRing(ctx)) {
        ctx.state.recordEvent({ userStoppedAt: ctx.now(), lastEvent: 'user-stop', lastEventAt: ctx.now() });
        if (activeRing(ctx).id === 'routine') ctx.state.endRing(ctx.now());
        return { version: '1.0', response: { directives: [{ type: 'AudioPlayer.Stop' }], shouldEndSession: true } };
    }
    // Nothing is ringing (the engine already ended it): just make sure the audio stops, silently.
    return { version: '1.0', response: { directives: [{ type: 'AudioPlayer.Stop' }], shouldEndSession: true } };
}

// ---- talking to Hermes ----

// Does the Echo keep listening after Hermes answers? By default only when Hermes asked you something.
//   config.skill.listen: "question" (default) | "always" | "never"
function listenAfter(ctx, answer) {
    const sk = ctx.config.skill || {};
    const mode = sk.conversation === false ? 'never' : sk.listen || 'question';
    return mode === 'always' || (mode === 'question' && convo.askedQuestion(answer));
}

function conversation(ctx, resume) {
    const sk = ctx.config.skill || {};
    return convo.pick({ attrs: ctx.attrs, store: ctx.state.readConvos(), profile: ctx.profile, resume, now: ctx.now(), maxAgeMs: (sk.resumeHours ?? 12) * convo.HOUR });
}

const remember = (ctx, c, question) => ctx.state.writeConvos(convo.remember({ store: ctx.state.readConvos(), profile: ctx.profile, name: c.name, question, now: ctx.now() }));

const reply = (ctx, c, text) => {
    const listen = listenAfter(ctx, text);
    return say(text, { end: !listen, reprompt: listen ? "Go ahead, I'm listening." : undefined, conv: c.name });
};

const streamAnswer = (ctx, id) => ({ version: '1.0', response: { directives: [play(ctx.voiceUrl(id), `voice|${id}`)], shouldEndSession: true } });

// resume: this is "continue ..." / "follow up ..." (also "tell me more"): the last conversation goes on instead of a new one.
async function chat(text, ctx, { resume = false } = {}) {
    const inSession = !!(ctx.attrs && ctx.attrs.conv);
    const asked = resume; // said "continue" out loud: tell you when the last conversation is too old
    if (!resume && !inSession && convo.FOLLOW_UP.test(text)) resume = true;
    const c = conversation(ctx, resume);
    remember(ctx, c, text);
    const stale = asked && c.stale ? 'That conversation is too old, so this is a new one.' : '';
    const sk = ctx.config.skill || {};

    if (ctx.voice) {
        // An earlier background task that finished since you last talked: tell you first.
        const earlier = ctx.state.readPending();
        let preface = stale;
        if (earlier && earlier.background && earlier.status === 'ready' && ctx.now() - (earlier.readyAt || 0) < PENDING_FRESH_MS) {
            preface = `${preface} Before I start: your earlier task finished. ${String(earlier.answer || '').slice(0, 300)}`.trim();
        }
        // The spoken stream takes the speaker over (AudioPlayer), and that drops Bluetooth music. So an answer that arrives in
        // time is said in Alexa's own voice instead: the music just ducks. Only a slow one becomes a stream, unless music mode is on.
        const music = ctx.state.readPrefs().musicMode === true;
        const quickMs = (sk.speech || {}).quickReplyMs ?? 7000;
        const inline = !!ctx.voice.settle && (music || quickMs > 0);
        const { id } = ctx.voice.start(text, { profile: ctx.profile, preface: inline ? undefined : preface || undefined, session: c.name, defer: inline, hint: true });
        if (!inline) return streamAnswer(ctx, id);
        const r = await ctx.voice.settle(id, quickMs || 7000);
        if (r) {
            ctx.voice.discard(id);
            if (r.error) return say(`${preface} ${r.error.spoken}`.trim(), { conv: null });
            return reply(ctx, c, `${preface} ${r.answer}`.trim());
        }
        if (music) {
            // The session stays open a moment: "give me the answer" works without saying "Alexa, ask Hermes" again.
            return say(`${preface} On it. Give it a moment, then say: give me the answer.`.trim(), { end: false, reprompt: "Say: give me the answer, when you're ready.", conv: c.name });
        }
        ctx.voice.promote(id);
        return streamAnswer(ctx, id);
    }

    const fastMs = sk.fastReplyMs ?? 6000;
    const opts = { session: c.name };
    if (ctx.profile) opts.profile = ctx.profile;
    const answer = ctx.askHermes(text, opts);
    let timer;
    const settled = answer.then(
        (v) => ({ ok: true, v }),
        (e) => ({ ok: false, e })
    );
    const first = await Promise.race([settled, new Promise((r) => (timer = setTimeout(() => r(null), fastMs)))]);
    clearTimeout(timer);

    if (first && first.ok) return reply(ctx, c, `${stale} ${first.v}`.trim());
    if (first && !first.ok) {
        const why = explain(first.e);
        ctx.log(`Hermes failed (${why.kind}): ${why.detail}`);
        return say(why.spoken);
    }
    // Too slow for Alexa's ~8 second limit and no spoken stream: keep the answer, you ask for it:
    // "Alexa, ask Hermes, give me the answer".
    ctx.state.writePending({ status: 'working', question: text, startedAt: ctx.now(), conv: c.name });
    settled.then((r) => {
        const answer = r.ok ? r.v : "Sorry, Hermes didn't answer.";
        if (!r.ok) ctx.log(`Hermes failed: ${r.e.message}`);
        ctx.state.writePending({ status: 'ready', question: text, answer, startedAt: ctx.now(), readyAt: ctx.now(), conv: c.name });
    });
    return say('On it. Give it a few seconds, then say: ask Hermes, give me the answer.');
}

// "continue" on its own: the last conversation is open again and the Echo listens for what you add.
function resumeListen(ctx) {
    const c = conversation(ctx, true);
    if (c.stale) return say("I don't have a recent conversation to continue. Ask me something first.");
    const last = (ctx.state.readConvos()[convo.keyOf(ctx.profile)] || {}).last;
    const about = last ? ` Last we talked about: ${last.length > 90 ? `${last.slice(0, 89).trim()}…` : last}.` : '';
    return say(`Okay, picking up where we left off.${about} What would you like to add?`, { end: false, reprompt: "Go ahead, I'm listening.", conv: c.name });
}

// "start over": the next question is a new conversation.
function newChat(ctx) {
    const store = ctx.state.readConvos();
    delete store[convo.keyOf(ctx.profile)];
    ctx.state.writeConvos(store);
    return say('Okay, fresh start. What would you like to ask?', { end: false, reprompt: "Go ahead, I'm listening.", conv: null });
}

// "music mode": never take the speaker over with a stream, so Bluetooth music is not interrupted.
function musicMode(on, ctx) {
    ctx.state.writePrefs({ musicMode: on });
    return say(
        on
            ? "Music mode is on. I'll answer in my own voice and your Bluetooth music keeps playing. A slow answer waits until you ask: ask Hermes, give me the answer."
            : 'Music mode is off. A slow answer plays as a live spoken stream, and that can interrupt Bluetooth music.'
    );
}

// "give me the answer" / "any update": reads out the slow answer once it is ready, or says how far Hermes has got.
function lastAnswer(ctx) {
    const p = ctx.state.readPending();
    if (!p || ctx.now() - (p.readyAt || p.startedAt) > PENDING_FRESH_MS) return say('I have nothing waiting for you.');
    if (p.status === 'working') {
        const mins = Math.max(0, Math.round((ctx.now() - p.startedAt) / 60000));
        const steps = (p.progress || []).map((x) => x.text).filter(Boolean);
        const last = steps.length ? ` The latest: ${steps[steps.length - 1]}.` : '';
        const took = mins >= 1 ? ` It has been ${mins} minute${mins === 1 ? '' : 's'}.` : '';
        const hc = ctx.config.hermes || {};
        const msg = hc.notifyTarget && hc.mode !== 'gateway' ? " I'll message you when it's done." : ' Ask me again in a bit.';
        // Still on the line (not handed off to the background): keep listening, so you can ask again in a few seconds.
        if (!p.background) return say(`Still working on it.${took}${last}`, { end: false, reprompt: "Say: give me the answer, when you're ready.", conv: p.conv });
        return say(`Still working on it.${took}${last}${msg}`);
    }
    ctx.state.clearPending();
    const listen = listenAfter(ctx, p.answer);
    return say(p.answer, { end: !listen, reprompt: listen ? "Go ahead, I'm listening." : undefined, conv: p.conv });
}

// "cancel the task": stops the Hermes run that is still going.
function cancelTask(ctx) {
    if (ctx.voice && ctx.voice.cancel()) return say('Okay, I stopped it.');
    return say("There's nothing running right now.");
}

// Instant checks that never touch the AI: they answer inside Alexa's time limit.
async function health(kind, ctx) {
    if (!ctx.health) return say('Health checks are not set up on this server.');
    try {
        const call = { test: 'test', bridge: 'testBridge', hermes: 'testHermes' }[kind] || 'report';
        const r = await ctx.health[call]();
        return say(r.spoken);
    } catch (e) {
        ctx.log(`health check failed: ${e.message}`);
        return say("I couldn't run that check.");
    }
}

// "update Hermes": runs on the Hermes machine as a live job: says it is checking/updating, then says when it is done.
function updateHermes(ctx) {
    if (!ctx.voice || !ctx.voice.startJob || !ctx.health || !ctx.health.updateHermes) return say("I can't update Hermes from here. The spoken stream or health checks are not set up.");
    const { id } = ctx.voice.startJob('update Hermes', (h) => ctx.health.updateHermes(h));
    return { version: '1.0', response: { directives: [play(ctx.voiceUrl(id), `voice|${id}`)], shouldEndSession: true } };
}

function yoloIntent(kind, ctx) {
    if (!ctx.yolo) return say('Yolo mode is not available here.');
    if (kind === 'status') {
        return say(ctx.yolo.isOn() ? 'Yolo mode is on. Hermes runs commands without asking.' : 'Yolo mode is off. Hermes may wait for permission, and gives up after a minute.');
    }
    ctx.yolo.set(kind === 'on');
    return say(kind === 'on' ? 'Yolo mode is on. Hermes will not ask for permission.' : 'Yolo mode is off. Hermes may ask for permission, and gives up after a minute.');
}

const slotValue = (intent, name) => {
    const s = intent.slots && intent.slots[name];
    return s && s.value ? String(s.value).trim() : '';
};

async function intent(it, ctx) {
    const name = it.name;
    if (QUERY_INTENTS[name]) {
        const q = slotValue(it, 'query');
        if (QUERY_INTENTS[name].resume) return q ? chat(q, ctx, { resume: true }) : resumeListen(ctx);
        if (!q) return say("I didn't catch that. Try again.", { end: false, reprompt: 'What would you like to ask?' });
        return chat(`${QUERY_INTENTS[name].prefix}${q}`, ctx);
    }
    switch (name) {
        case 'RingAlarmIntent':
            return ring(ctx);
        case 'LastAnswerIntent':
            return lastAnswer(ctx);
        case 'CancelTaskIntent':
            return cancelTask(ctx);
        case 'TestServerIntent':
            return health('test', ctx);
        case 'TestBridgeIntent':
            return health('bridge', ctx);
        case 'TestHermesIntent':
            return health('hermes', ctx);
        case 'UpdateHermesIntent':
            return updateHermes(ctx);
        case 'HealthIntent':
            return health('report', ctx);
        case 'YoloOnIntent':
            return yoloIntent('on', ctx);
        case 'YoloOffIntent':
            return yoloIntent('off', ctx);
        case 'YoloStatusIntent':
            return yoloIntent('status', ctx);
        case 'AMAZON.StopIntent':
        case 'AMAZON.CancelIntent':
        case 'AMAZON.PauseIntent':
            return stop(ctx);
        case 'AMAZON.HelpIntent':
            return say("Ask me anything. For example: what's on my plate today, or remind me to call Rohan.", { end: false, reprompt: 'What would you like to ask?' });
        case 'NewChatIntent':
            return newChat(ctx);
        case 'MusicModeOnIntent':
            return musicMode(true, ctx);
        case 'MusicModeOffIntent':
            return musicMode(false, ctx);
        // A yes or no while Hermes is waiting for your answer goes to Hermes.
        case 'AMAZON.YesIntent':
            if (ctx.attrs && ctx.attrs.conv) return chat('Yes.', ctx);
            return say('What would you like to ask?', { end: false, reprompt: 'Go ahead.' });
        case 'AMAZON.NoIntent':
            if (ctx.attrs && ctx.attrs.conv) return chat('No.', ctx);
            return say('Okay.');
        case 'AMAZON.NavigateHomeIntent':
            return say('Okay.');
        case 'AMAZON.FallbackIntent':
            if (ctx.attrs && ctx.attrs.conv) return say('I missed that. Start your answer with a word like my, the, I or it. For example: the second one.', { end: false, reprompt: 'What is your answer?' });
            return say("I missed that. Say it again, starting with a word like check, show, find, send, what or how.", { end: false, reprompt: 'What would you like to ask?' });
        default:
            return say('Okay.');
    }
}

async function handle(envelope, ctx) {
    const req = (envelope && envelope.request) || {};
    const type = req.type || '';
    if (type === 'LaunchRequest') {
        return say('Hermes here. What do you need?', { end: false, reprompt: 'Go ahead, ask me anything.' });
    }
    if (type === 'IntentRequest') {
        ctx.attrs = (envelope.session && envelope.session.attributes) || {};
        const out = await intent(req.intent || {}, ctx);
        // The session stays open and the answer did not name a conversation: carry the current one over.
        if (out.response && out.response.shouldEndSession === false && out.sessionAttributes === undefined && ctx.attrs.conv) out.sessionAttributes = { conv: ctx.attrs.conv };
        return out;
    }
    if (type.startsWith('AudioPlayer.')) return audioEvent(req, ctx);
    if (type === 'System.ExceptionEncountered') ctx.log(`Alexa reported an error: ${JSON.stringify(req.error || {})}`);
    return empty();
}

const PLAIN_INTENTS = {
    RingAlarmIntent: RING_SAMPLES,
    LastAnswerIntent: ANSWER_SAMPLES,
    CancelTaskIntent: CANCEL_SAMPLES,
    TestServerIntent: TEST_SAMPLES,
    TestBridgeIntent: TEST_BRIDGE_SAMPLES,
    TestHermesIntent: TEST_HERMES_SAMPLES,
    UpdateHermesIntent: UPDATE_SAMPLES,
    HealthIntent: HEALTH_SAMPLES,
    YoloOnIntent: YOLO_ON_SAMPLES,
    YoloOffIntent: YOLO_OFF_SAMPLES,
    YoloStatusIntent: YOLO_STATUS_SAMPLES,
    NewChatIntent: NEW_CHAT_SAMPLES,
    MusicModeOnIntent: MUSIC_ON_SAMPLES,
    MusicModeOffIntent: MUSIC_OFF_SAMPLES,
};

// "Ask Hermes <anything>": Alexa only hands over free text that starts with a word the model knows, so the more
// opening words are listed here, the more of what you say reaches Hermes untouched.
//
// Alexa refuses a model where (intents + slots) is over 350, and every opening word with its own intent costs two.
// So the words that change the meaning when dropped (verbs, question words, "today", "latest") get an intent each and the
// word is put back in front of what you said. Little words that can be dropped without changing anything ("my", "the",
// "our", "and", "okay") share ONE intent with many samples: the word is cut, the rest goes to Hermes.
const MEANINGFUL_CARRIERS = [
    // questions
    'which', 'whose', 'should', 'could', 'would', 'will', 'does', 'did', 'was', 'were', 'has', 'have', 'could you', 'would you', 'will you', 'do you',
    'can i', 'should i', 'how many', 'how much', "how's", "who's", "where's",
    // time and filters
    'today', 'tomorrow', 'yesterday', 'tonight', 'now', 'next', 'last', 'latest', 'new', 'recent', 'unread', 'pending', 'top',
    // look things up
    'get', 'show', 'fetch', 'find', 'list', 'look up', 'look at', 'pull', 'summarize', 'summarise', 'explain', 'describe', 'compare', 'calculate',
    'translate', 'count', 'review', 'analyze', 'analyse', 'track', 'monitor', 'scan', 'research', 'recommend', 'suggest',
    // do things
    'send', 'draft', 'write', 'create', 'make', 'run', 'email', 'message', 'text', 'call', 'schedule', 'book', 'post', 'reply', 'forward', 'delete',
    'archive', 'go', 'generate', 'plan', 'prepare', 'save', 'note', 'log', 'record', 'download', 'upload', 'share', 'export', 'sync', 'backup', 'restart',
    'deploy', 'build', 'fix', 'debug', 'install', 'clear', 'clean', 'sort', 'filter', 'merge', 'move', 'copy', 'put', 'keep', 'wait', 'ignore', 'mute',
    'snooze', 'wake', 'order', 'buy', 'pay', 'invoice', 'close', 'launch', 'finish', 'complete', 'continue', 'try', 'let me', "let's", 'remember', 'forget',
    'follow up', 'ping', 'edit', 'open', 'bring', 'pick', 'choose', 'organize',
];
// Dropping these changes nothing: "my latest emails" and "latest emails" mean the same.
const FILLER_WORDS = [
    'my', 'our', 'the', 'a', 'an', 'this', 'that', 'these', 'those', 'i', 'we', 'you', 'it', 'there', 'all', 'every', 'some', 'any', 'and', 'then', 'also',
    'okay', 'ok', 'hey', 'so', 'but', 'well', 'just', 'please', 'um', 'uh', 'listen', 'sure', 'right', 'actually', 'maybe', 'and then', 'so then',
    'quick question', 'one more thing', 'by the way', 'thanks', 'thank you', 'hello', 'hi', 'good morning', 'good evening', 'one', 'two', 'three', 'both',
    'each', 'another', 'other', 'more', 'less', 'only', 'again', 'still', 'already', 'about my', 'about our', 'about the', 'for my', 'for our', 'for the',
    'with my', 'with our', 'with the', 'from my', 'from our', 'from the', 'in my', 'in our', 'in the', 'on my', 'on our', 'on the', 'to my', 'to our', 'to the',
    'of my', 'of our', 'of the', 'at my', 'at the', 'if i', 'if we', 'if my', 'if the', 'i want', 'i need', 'i would like', "i'd like", 'we need', 'we want',
    'i have', 'i am', "i'm", 'i was', 'i will', "i'll", 'we have', 'we are', 'it is', "it's", 'this is', 'that is', "that's", 'there is', "there's", 'there are',
];
const firstWords = (samples) => samples.map((x) => x.split(' ')[0]);
(function addCarriers() {
    const plain = Object.values({ RING_SAMPLES, ANSWER_SAMPLES, CANCEL_SAMPLES, TEST_SAMPLES, TEST_BRIDGE_SAMPLES, TEST_HERMES_SAMPLES, UPDATE_SAMPLES, HEALTH_SAMPLES, YOLO_ON_SAMPLES, YOLO_OFF_SAMPLES, YOLO_STATUS_SAMPLES, NEW_CHAT_SAMPLES, MUSIC_ON_SAMPLES, MUSIC_OFF_SAMPLES }).flat();
    const used = new Set(Object.values(QUERY_INTENTS).flatMap((q) => q.samples.map((x) => x.replace(' {query}', '').trim())));
    const names = new Set(Object.keys(QUERY_INTENTS));
    const blockedFirst = new Set([...firstWords(plain), 'ask', 'to', 'stop', 'cancel', 'help', 'pause', 'resume', 'repeat', 'start', 'previous', 'yes', 'no']);
    const ok = (w) => !used.has(w) && !blockedFirst.has(w.split(' ')[0]) && !plain.some((x) => x === w || x.startsWith(`${w} `));
    for (const w of MEANINGFUL_CARRIERS.filter(ok)) {
        const name = `Ask${w.replace(/'/g, '').split(' ').map((t) => t[0].toUpperCase() + t.slice(1)).join('')}Intent`;
        if (names.has(name)) continue;
        QUERY_INTENTS[name] = { prefix: `${w} `, samples: [`${w} {query}`] };
        used.add(w);
        names.add(name);
    }
    const filler = FILLER_WORDS.filter(ok);
    QUERY_INTENTS.AskFillerIntent = { prefix: '', samples: [...new Set(filler)].map((w) => `${w} {query}`) };
})();

module.exports = { handle, QUERY_INTENTS, PLAIN_INTENTS, RING_SAMPLES, ANSWER_SAMPLES, ringToken, parseToken };
