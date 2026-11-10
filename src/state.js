'use strict';
// Small JSON files the skill keeps in the data folder:
//   skill-alarm-request.json   "play this file now" (active) or "stop" (inactive): the alarm that is ringing
//   skill-alarm-events.json    what the Echo reported back (started, stopped, you said stop...)
//   skill-pending.json         a slow Hermes answer waiting for you to ask for it

const fs = require('fs');
const path = require('path');
const { DATA_DIR, AUDIO_DIR } = require('./lib/config');

const requestFile = () => path.join(DATA_DIR, 'skill-alarm-request.json');
const pendingFile = () => path.join(DATA_DIR, 'skill-pending.json');
const eventsFile = () => path.join(DATA_DIR, 'skill-alarm-events.json');

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
}

const readRequest = () => readJson(requestFile(), null);
const readEvents = () => readJson(eventsFile(), {});

// Ask the skill to play `file`. Call again to re-trigger the same ring (keeps the original startedAt).
function requestRing({ id, file, now = Date.now(), retrigger = false }) {
    const prev = readRequest();
    const startedAt = retrigger && prev && prev.id === id ? prev.startedAt : now;
    writeJson(requestFile(), { active: true, id, file, startedAt, requestedAt: now });
    if (!retrigger) writeJson(eventsFile(), { requestId: id, since: now });
}

// Stop looping. The Echo itself is stopped by saying "stop".
function endRing(now = Date.now()) {
    const prev = readRequest();
    if (prev) writeJson(requestFile(), { ...prev, active: false, endedAt: now });
}

// Remember an Echo event. `once` fields keep their first value.
function recordEvent(patch, { once = [] } = {}) {
    const req = readRequest();
    const ev = readEvents();
    const next = { ...ev, requestId: ev.requestId || (req && req.id) || null };
    for (const [k, v] of Object.entries(patch)) if (!(once.includes(k) && next[k])) next[k] = v;
    writeJson(eventsFile(), next);
    return next;
}

// A Hermes answer that was too slow for Alexa's time limit, kept so you can ask for it ("ask Hermes, give me the answer").
const readPending = () => readJson(pendingFile(), null);
const writePending = (p) => writeJson(pendingFile(), p);
const clearPending = () => {
    try {
        fs.unlinkSync(pendingFile());
    } catch {
        /* nothing pending */
    }
};

// The Hermes conversation you can pick up again ("ask Hermes, continue"): one per Hermes profile.
//   { <profile or "default">: { name, updatedAt, turns, last } }   name is the Hermes session name (hermes chat --continue <name>)
const convoFile = () => path.join(DATA_DIR, 'skill-conversations.json');
const readConvos = () => readJson(convoFile(), {});
const writeConvos = (c) => writeJson(convoFile(), c);

// Switches you set by voice and that survive a restart, e.g. { musicMode: true }.
const prefsFile = () => path.join(DATA_DIR, 'skill-prefs.json');
const readPrefs = () => readJson(prefsFile(), {});
const writePrefs = (patch) => writeJson(prefsFile(), { ...readPrefs(), ...patch });

module.exports = { readConvos, writeConvos, readPrefs, writePrefs, readPending, writePending, clearPending, AUDIO_DIR, readRequest, readEvents, requestRing, endRing, recordEvent, requestFile, eventsFile };
