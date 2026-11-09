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
const PENDING_FRESH_MS = 30 * 60 * 1000;
const MAX_SPOKEN = 900;
const RING_FRESH_MS = 2 * 60 * 1000; // a ring requested within the last 2 minutes is still the current one

const empty = () => ({ version: '1.0', response: {} });

function say(text, { end = true, reprompt } = {}) {
    const response = { outputSpeech: { type: 'PlainText', text: String(text).slice(0, MAX_SPOKEN) }, shouldEndSession: end };
    if (!end && reprompt) response.reprompt = { outputSpeech: { type: 'PlainText', text: reprompt } };
    return { version: '1.0', response };
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

async function chat(text, ctx) {
    if (ctx.voice) {
        // Spoken answer stream: Hermes starts now, the Echo plays a live audio stream that talks when there is something to say.
        // An earlier background task that finished since you last talked: tell you first.
        const earlier = ctx.state.readPending();
        let preface;
        if (earlier && earlier.background && earlier.status === 'ready' && ctx.now() - (earlier.readyAt || 0) < PENDING_FRESH_MS) {
            preface = `Before I start: your earlier task finished. ${String(earlier.answer || '').slice(0, 300)}`;
        }
        const { id } = ctx.voice.start(text, { profile: ctx.profile, preface });
        return { version: '1.0', response: { directives: [play(ctx.voiceUrl(id), `voice|${id}`)], shouldEndSession: true } };
    }
    const sk = ctx.config.skill || {};
    const fastMs = sk.fastReplyMs ?? 6000;
    const conversation = sk.conversation !== false;
    const answer = ctx.profile ? ctx.askHermes(text, { profile: ctx.profile }) : ctx.askHermes(text);
    let timer;
    const settled = answer.then(
        (v) => ({ ok: true, v }),
        (e) => ({ ok: false, e })
    );
    const first = await Promise.race([settled, new Promise((r) => (timer = setTimeout(() => r(null), fastMs)))]);
    clearTimeout(timer);

    if (first && first.ok) return say(first.v, { end: !conversation, reprompt: 'Anything else?' });
    if (first && !first.ok) {
        const why = explain(first.e);
        ctx.log(`Hermes failed (${why.kind}): ${why.detail}`);
        return say(why.spoken);
    }
    // Too slow for Alexa's ~8 second limit and no spoken stream: keep the answer, you ask for it:
    // "Alexa, ask Hermes, give me the answer".
    ctx.state.writePending({ status: 'working', question: text, startedAt: ctx.now() });
    settled.then((r) => {
        const answer = r.ok ? r.v : "Sorry, Hermes didn't answer.";
        if (!r.ok) ctx.log(`Hermes failed: ${r.e.message}`);
        ctx.state.writePending({ status: 'ready', question: text, answer, startedAt: ctx.now(), readyAt: ctx.now() });
    });
    return say('On it. Give it a few seconds, then say: ask Hermes, give me the answer.');
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
        return say(`Still working on it.${took}${last}${msg}`);
    }
    ctx.state.clearPending();
    return say(p.answer, { end: false, reprompt: 'Anything else?' });
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
        case 'AMAZON.YesIntent':
            return say('What would you like to ask?', { end: false, reprompt: 'Go ahead.' });
        case 'AMAZON.NoIntent':
        case 'AMAZON.NavigateHomeIntent':
            return say('Okay.');
        case 'AMAZON.FallbackIntent':
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
    if (type === 'IntentRequest') return intent(req.intent || {}, ctx);
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
    const plain = Object.values({ RING_SAMPLES, ANSWER_SAMPLES, CANCEL_SAMPLES, TEST_SAMPLES, TEST_BRIDGE_SAMPLES, TEST_HERMES_SAMPLES, UPDATE_SAMPLES, HEALTH_SAMPLES, YOLO_ON_SAMPLES, YOLO_OFF_SAMPLES, YOLO_STATUS_SAMPLES }).flat();
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
