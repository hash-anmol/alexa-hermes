'use strict';
// Spoken answers that arrive on their own.
//
// Alexa cuts a skill off after ~8 seconds, and Hermes often needs 10-20 (sometimes 30 minutes). So instead of answering
// with speech, the skill answers with AudioPlayer.Play pointing at a live mp3 stream served from here. The stream:
//   - starts with a short chime (you hear that it got the question),
//   - keeps the connection alive with silence while Hermes works ("One moment", "Still on it"),
//   - says a short progress line when Hermes starts using a tool ("Searching the web."),
//   - speaks what Hermes says as it writes it: first its intention, then the answer, sentence by sentence,
//   - ends after the last sentence.
// LONG TASKS: after `foregroundSec` (60) the stream says it will take a while and ends. Hermes keeps working; each step is
// kept as progress ("ask Hermes, any update"), the finished answer is kept, you get a message (if hermes.notifyTarget is set), and the next time you
// talk to it, it tells you first.
// "Alexa, stop" closes the stream; the answer is then kept for "ask Hermes, give me the answer".
//
// createVoice({ audio, streamHermes, state, config, log, now, tickMs, notify, isYolo })
//   audio:        { speak(text) -> Promise<Buffer mp3>, silence(sec) -> Buffer, chime() -> Buffer }   (see tts.js)
//   streamHermes: (question, onEvent, { timeoutMs, rules, profile, signal }) -> Promise<{ text }>   (see hermes-client.js)
//   state:        { writePending, clearPending }   (see state.js)
//   notify:       (text) -> Promise   optional: tells you (a message through `hermes send`, for example Slack) when a background task has finished
//   isYolo:       () -> boolean       optional: only used to hint at YOLO mode when Hermes says it needed permission

const crypto = require('crypto');
const { toSpokenText, VOICE_RULES } = require('./hermes-client');
const { explain } = require('./lib/errors');
const yolo = require('./lib/yolo');

const BYTES_PER_SEC = 6000; // 48 kbps mp3
const LEAD_SEC = 1.2; // how much audio is kept queued ahead of the player
const MIN_SENTENCE = 25;
const MAX_PIECE = 280;
const KEEP_MS = 10 * 60 * 1000;
const handoffText = (mins, willMessage) =>
    `This is taking more than ${mins} minutes. I'll keep working${willMessage ? " and message you when it's done" : ''}. You can ask me for an update any time.`;
const NEEDS_PERMISSION = /approv|permission|not allowed|was denied|blocked/i;
const short = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n - 1).trim()}…` : String(s));

// Cuts streaming text into sentences that are worth a text-to-speech call. Only sentences followed by whitespace count
// as finished, short pieces ("Dr.") are glued to the next one, an unbroken run gets cut at a comma or space.
function takeSentences(buf, final = false) {
    const out = [];
    let start = 0;
    const re = /(?:[.!?]["')\]]*|\n)\s+/g;
    let m;
    while ((m = re.exec(buf))) {
        const end = m.index + m[0].length;
        const piece = buf.slice(start, end).trim();
        if (piece.length < MIN_SENTENCE) continue;
        out.push(piece);
        start = end;
    }
    let rest = buf.slice(start);
    if (!final && rest.length > MAX_PIECE) {
        const cut = Math.max(rest.lastIndexOf(', ', MAX_PIECE), rest.lastIndexOf(' ', MAX_PIECE));
        if (cut > 60) {
            out.push(rest.slice(0, cut + 1).trim());
            rest = rest.slice(cut + 1);
        }
    }
    if (final && rest.trim()) {
        out.push(rest.trim());
        rest = '';
    }
    return { sentences: out, rest };
}

function progressPhrase(name) {
    const n = String(name || '').toLowerCase();
    if (/search|web|browse|fetch|http/.test(n)) return 'Searching the web.';
    if (/calendar/.test(n)) return 'Checking your calendar.';
    if (/mail|slack|message/.test(n)) return 'Checking your messages.';
    if (/terminal|shell|bash|exec|command/.test(n)) return 'Running a command.';
    if (/file|read|write|edit/.test(n)) return 'Looking at a file.';
    return 'Working on it.';
}

function createVoice({ audio, streamHermes, state, config = {}, log = () => {}, now = Date.now, tickMs = 250, notify = null, isYolo = null }) {
    const sp = (config.skill && config.skill.speech) || {};
    const narrate = sp.narrate !== false;
    const foregroundSec = sp.foregroundSec ?? 900; // how long the stream stays on (15 minutes) before a task goes to the background
    const pulseMs = (sp.pulseSec ?? 60) * 1000; // a soft chime this often while it is quiet, so you know it is alive (0 = silent keep-alive only)
    const reportMs = (sp.reportMinutes ?? 5) * 60 * 1000; // "Still working, 5 minutes in." this often (0 = never)
    const maxMinutes = sp.maxMinutes ?? 45; // hard stop for a single Hermes run
    const ackMs = sp.ackMs ?? 3000; // "One moment." when Hermes has not said a word for this long
    const stillMs = sp.stillMs ?? 8000; // "Still on it." every this long of silence, until the answer starts
    const yoloOn = isYolo || (() => yolo.isOn(config.hermes || {}));
    const sessions = new Map();
    let latest = null;

    class Session {
        constructor(id, question, opts) {
            this.id = id;
            this.question = question;
            this.profile = opts.profile;
            this.job = opts.run || null; // a non-AI job (e.g. "update Hermes"): runs this instead of asking Hermes
            this.filler = !this.job; // "One moment." / "Still on it." only make sense while Hermes is thinking
            this.lastNoise = now(); // last time anything audible was added (speech or pulse)
            this.nextReport = reportMs;
            this.chunks = [];
            this.subs = new Set();
            this.produced = 0; // seconds of audio made so far
            this.t0 = null; // when the player first connected
            this.streamEnded = false; // the audio stream is closed
            this.finished = false; // Hermes is done
            this.endedAt = 0;
            this.startedAt = now();
            this.buf = '';
            this.chain = Promise.resolve();
            this.spokenAt = 0; // last time we said something (rate-limits tool narration)
            this.quietSince = now(); // start of the current stretch of silence
            this.stills = 0;
            this.narrations = 0;
            this.sawEvent = false;
            this.spokeText = false;
            this.backgrounded = false;
            this.progress = [];
            this.controller = new AbortController();
            this.append(audio.chime());
            if (opts.preface) this.say(opts.preface);
            this.ticker = setInterval(() => this.tick(), tickMs);
            this.ticker.unref();
            if (narrate && this.filler) {
                this.ack = setTimeout(() => {
                    if (!this.sawEvent && !this.streamEnded) this.say('One moment.');
                }, ackMs);
                this.ack.unref();
            }
            this.fgTimer = setTimeout(() => this.handoff(), foregroundSec * 1000);
            this.fgTimer.unref();
        }

        append(buf) {
            this.chunks.push(buf);
            this.produced += buf.length / BYTES_PER_SEC;
            for (const res of this.subs) res.write(buf);
        }

        say(text) {
            const clean = toSpokenText(text).slice(0, 400);
            if (!clean) return;
            log(`say: ${clean}`);
            this.spokenAt = this.quietSince = this.lastNoise = now();
            this.chain = this.chain
                .then(() => audio.speak(clean))
                .then((b) => this.append(b))
                .catch((e) => log(`speech failed: ${e.message}`));
        }

        // Keeps the stream alive: whenever the player is about to run dry, add half a second of silence.
        tick() {
            if (this.streamEnded || this.t0 === null) return;
            const played = (now() - this.t0) / 1000;
            if (this.produced - played < LEAD_SEC) this.append(audio.silence(0.5));
            const t = now();
            // Long task: every few minutes say how long it has been, then a soft chime each minute of quiet.
            if (reportMs && t - this.startedAt >= this.nextReport) {
                const mins = Math.round((t - this.startedAt) / 60000);
                this.nextReport += reportMs;
                this.say(`Still working. ${mins} minutes in.`);
            } else if (pulseMs && t - this.lastNoise >= pulseMs) {
                this.lastNoise = t;
                this.append(audio.softChime ? audio.softChime() : audio.chime());
            }
            // Hermes can think for 10+ seconds before the first word: say now and then that it is still going.
            if (narrate && this.filler && !this.spokeText && this.stills < 2 && now() - this.quietSince > stillMs) {
                this.stills++;
                this.say('Still on it.');
            }
        }

        // Too long to stay on the line: say so, end the stream, keep working.
        handoff() {
            if (this.finished || this.streamEnded) return;
            clearTimeout(this.ack);
            this.say(handoffText(Math.round(foregroundSec / 60), !!notify));
            this.backgrounded = true;
            this.writeWorking();
            this.chain = this.chain.then(() => this.endStream());
        }

        endStream() {
            if (this.streamEnded) return;
            this.append(audio.silence(0.5));
            this.streamEnded = true;
            this.endedAt = now();
            clearInterval(this.ticker);
            for (const res of this.subs) res.end();
            this.subs.clear();
        }

        // What "any update" reports while Hermes is still working.
        recordProgress(text) {
            this.progress.push({ at: now(), text: toSpokenText(text).slice(0, 200) });
            if (this.progress.length > 20) this.progress.shift();
            this.writeWorking();
        }
        writeWorking() {
            state.writePending({ status: 'working', question: this.question, startedAt: this.startedAt, progress: this.progress.slice(-5), background: this.backgrounded });
        }

        flushText(final) {
            const { sentences, rest } = takeSentences(this.buf, final);
            this.buf = rest;
            for (const s of sentences) {
                if (this.backgrounded) this.recordProgress(s);
                else {
                    this.spokeText = true;
                    this.say(s);
                }
            }
        }

        onEvent(ev) {
            this.sawEvent = true;
            if (ev.type === 'tool_use') {
                const phrase = progressPhrase(ev.name);
                this.recordProgress(phrase.replace(/\.$/, '')); // kept for "any update", even the steps heard before the hand-off
                // Say what it is doing, but not the same thing twice in a row, and not more than once every few seconds.
                if (!this.backgrounded && narrate && this.narrations < 12 && now() - this.spokenAt > 4000 && phrase !== this.lastPhrase) {
                    this.narrations++;
                    this.lastPhrase = phrase;
                    this.say(phrase);
                }
            }
            if (ev.type === 'text' && typeof ev.text === 'string') {
                this.buf += ev.text;
                this.flushText(false);
            }
        }

        async run() {
            let answer = null;
            let error = null;
            try {
                const out = this.job
                    ? { text: await this.job({ say: (t) => this.say(t), progress: (t) => this.recordProgress(t), signal: this.controller.signal, timeoutMs: maxMinutes * 60 * 1000 }) }
                    : await streamHermes(this.question, (ev) => this.onEvent(ev), {
                          timeoutMs: maxMinutes * 60 * 1000,
                          rules: VOICE_RULES,
                          profile: this.profile,
                          signal: this.controller.signal,
                      });
                answer = out.text;
                this.flushText(true);
                if (!this.spokeText && !this.backgrounded && answer) {
                    this.buf = answer;
                    this.flushText(true);
                }
                if (!this.backgrounded && answer && !yoloOn() && NEEDS_PERMISSION.test(answer)) {
                    this.say('If you want me to stop asking permission, say: ask Hermes, turn on yolo mode.');
                }
            } catch (e) {
                error = explain(e);
                log(`Hermes failed (${error.kind}): ${error.detail}`);
                if (error.kind !== 'cancelled' && !this.backgrounded) this.say(error.spoken);
            }
            await this.chain;
            this.finish(answer, error);
        }

        finish(answer, error) {
            if (this.finished) return;
            this.finished = true;
            clearTimeout(this.fgTimer);
            clearTimeout(this.ack);
            const cancelled = error && error.kind === 'cancelled';
            if (this.backgrounded) {
                this.progress = [];
                if (cancelled) return state.clearPending();
                const text = error ? error.spoken : answer;
                state.writePending({ status: 'ready', question: this.question, answer: text, background: true, startedAt: this.startedAt, readyAt: now() });
                if (notify) {
                    Promise.resolve(notify(`Hermes ${error ? 'hit a problem with' : 'finished'} "${short(this.question)}": ${text}`)).catch((e) => log(`could not notify: ${e.message}`));
                }
                return;
            }
            const delivered = this.subs.size > 0;
            this.endStream();
            if (delivered || !answer) state.clearPending();
            else state.writePending({ status: 'ready', question: this.question, answer, startedAt: this.startedAt, readyAt: this.endedAt });
        }

        cancel() {
            this.controller.abort();
        }

        attach(req, res) {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'X-Accel-Buffering': 'no' });
            if (req.method === 'HEAD') return res.end();
            for (const c of this.chunks) res.write(c);
            if (this.streamEnded) return res.end();
            if (this.t0 === null) this.t0 = now();
            this.subs.add(res);
            log(`stream opened (${this.id.slice(0, 6)})`);
            res.on('close', () => {
                this.subs.delete(res);
                if (!this.streamEnded) log(`stream closed by the Echo before the end (${this.id.slice(0, 6)})`);
            });
        }
    }

    const sweep = setInterval(() => {
        for (const [id, s] of sessions) if (s.finished && s.streamEnded && now() - s.endedAt > KEEP_MS) sessions.delete(id);
    }, 60000);
    sweep.unref();

    return {
        // Starts Hermes right away (before the Echo has even connected) and returns the id for the stream URL.
        //   opts.profile: which Hermes profile answers (default profile when empty)
        //   opts.preface: something to say first (e.g. "Your earlier task finished: ...")
        //   opts.run:     a function instead of Hermes: ({ say, progress, signal, timeoutMs }) -> Promise<final spoken text>
        start(question, opts = {}) {
            const id = crypto.randomBytes(9).toString('hex');
            const s = new Session(id, question, opts);
            sessions.set(id, s);
            latest = s;
            state.writePending({ status: 'working', question, startedAt: s.startedAt });
            s.run();
            return { id };
        },
        has: (id) => sessions.has(id),
        attach(id, req, res) {
            const s = sessions.get(id);
            if (!s) return false;
            s.attach(req, res);
            return true;
        },
        // Runs a non-AI job (like "update Hermes") with the same live stream, chimes, hand-off and message as a Hermes task.
        startJob(label, run, opts = {}) {
            return this.start(label, { ...opts, run });
        },
        // "cancel the task": stops the latest Hermes run that is still going. Returns whether there was one.
        cancel() {
            if (!latest || latest.finished) return false;
            latest.cancel();
            return true;
        },
        close() {
            clearInterval(sweep);
            for (const s of sessions.values()) {
                clearInterval(s.ticker);
                clearTimeout(s.ack);
                clearTimeout(s.fgTimer);
            }
        },
    };
}

module.exports = { createVoice, takeSentences, progressPhrase, BYTES_PER_SEC };
