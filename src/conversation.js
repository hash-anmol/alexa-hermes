'use strict';
// Which Hermes conversation a spoken question belongs to.
//
// Every "ask Hermes <question>" starts a new Hermes conversation (a named session: `hermes chat --continue <name>`),
// EXCEPT when you are continuing one:
//   - inside the same Alexa session (Hermes asked you something, or you opened Hermes and keep talking): same conversation
//   - "ask Hermes, continue <what you add>" / "follow up <what you add>" / "tell me more": the last conversation, if it is recent
// "start over" forgets the last conversation.

const HOUR = 60 * 60 * 1000;

// Did Hermes end on a question for you? Then the conversation is waiting for your answer.
const askedQuestion = (text) => /\?["')\]]*\s*$/.test(String(text || '').trim());

// Said at the start of a fresh session, these only make sense as "keep going with the last conversation".
const FOLLOW_UP = /^(tell me more|more about (that|this|it)|go on|keep going|carry on|say more|elaborate|continue)\b/i;

const newName = (now = Date.now()) => `alexa-${now.toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
const keyOf = (profile) => profile || 'default';

// -> { name, resumed, stale }   resumed: this is a continuation; stale: you asked to continue, but the last one is too old (or none)
function pick({ attrs, store, profile, resume, now, maxAgeMs = 12 * HOUR }) {
    if (attrs && attrs.conv) return { name: attrs.conv, resumed: true, stale: false };
    const last = store && store[keyOf(profile)];
    if (resume) {
        if (last && now - last.updatedAt < maxAgeMs) return { name: last.name, resumed: true, stale: false };
        return { name: newName(now), resumed: false, stale: true };
    }
    return { name: newName(now), resumed: false, stale: false };
}

function remember({ store, profile, name, question, now }) {
    const key = keyOf(profile);
    const prev = store[key] && store[key].name === name ? store[key] : null;
    return { ...store, [key]: { name, updatedAt: now, turns: (prev ? prev.turns : 0) + 1, last: String(question).slice(0, 200) } };
}

module.exports = { askedQuestion, FOLLOW_UP, newName, pick, remember, keyOf, HOUR };
