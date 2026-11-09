'use strict';
// Builds the Alexa interaction model from the intents in handlers.js, so the two can never drift apart.
//   alexa-hermes model [invocation-name] [out-file]
//        -> writes build/interaction-model.<name>.json (one model per skill; one skill per Hermes profile)
// Paste that file into the Alexa developer console (Build > Interaction Model > JSON Editor).
//
// config.json -> skill.extraPhrases adds your own sample phrases to the built-in commands, for example
//   { "TestHermesIntent": ["test my cloud server"], "RingAlarmIntent": ["ring my wake up alarm"] }
// An extra phrase must not start with an opening word of "ask Hermes <anything>" (what, how, check, send, wake ...;
// see src/handlers.js): those are reported and left out, because Alexa could mistake them for a question.

const fs = require('fs');
const path = require('path');
const { QUERY_INTENTS, PLAIN_INTENTS } = require('./handlers');

// Alexa refuses to build a model where (intents + slots) is more than this.
const ALEXA_LIMIT = 350;

// First words of "ask Hermes <anything>": a built-in command may not start with one, or Alexa could mistake it for a question.
const openers = () => new Set(Object.values(QUERY_INTENTS).flatMap((q) => q.samples.map((x) => x.split(' ')[0])));

// Splits user-supplied phrases into the usable ones and the ones that would collide (reported, not silently dropped).
function checkExtra(extraPhrases = {}) {
    const bad = openers();
    const ok = {};
    const rejected = [];
    for (const [intent, list] of Object.entries(extraPhrases)) {
        if (!PLAIN_INTENTS[intent]) {
            rejected.push(`${intent}: no such built-in command`);
            continue;
        }
        for (const raw of list) {
            const phrase = String(raw).toLowerCase().trim();
            if (!phrase || bad.has(phrase.split(' ')[0])) rejected.push(`"${raw}" starts with an opening word of free-form questions`);
            else (ok[intent] = ok[intent] || []).push(phrase);
        }
    }
    return { ok, rejected };
}

function buildModel(invocationName = 'hermes', { extraPhrases = {} } = {}) {
    extraPhrases = checkExtra(extraPhrases).ok;
    const plain = Object.entries(PLAIN_INTENTS).map(([name, samples]) => ({
        name,
        slots: [],
        samples: [...new Set([...samples, ...(extraPhrases[name] || [])])],
    }));
    const intents = [
        { name: 'AMAZON.CancelIntent', samples: [] },
        { name: 'AMAZON.HelpIntent', samples: [] },
        { name: 'AMAZON.StopIntent', samples: [] },
        { name: 'AMAZON.PauseIntent', samples: [] },
        { name: 'AMAZON.NavigateHomeIntent', samples: [] },
        { name: 'AMAZON.FallbackIntent', samples: [] },
        { name: 'AMAZON.YesIntent', samples: [] },
        { name: 'AMAZON.NoIntent', samples: [] },
        ...plain,
        ...Object.entries(QUERY_INTENTS).map(([name, q]) => ({
            name,
            slots: [{ name: 'query', type: 'AMAZON.SearchQuery' }],
            samples: q.samples,
        })),
    ];
    return { interactionModel: { languageModel: { invocationName, intents, types: [] } } };
}

const sizeOf = (model) => {
    const intents = model.interactionModel.languageModel.intents;
    return intents.length + intents.reduce((n, i) => n + (i.slots ? i.slots.length : 0), 0);
};

if (require.main === module) {
    const { loadConfig, ROOT } = require('./lib/config');
    const inv = (process.argv[2] || (loadConfig().skill || {}).invocation || 'hermes').toLowerCase();
    const extra = (loadConfig().skill || {}).extraPhrases || {};
    for (const r of checkExtra(extra).rejected) console.warn(`skipped extra phrase: ${r}`);
    const model = buildModel(inv, { extraPhrases: extra });
    const out = process.argv[3] || path.join(ROOT, 'build', `interaction-model.${inv.replace(/\s+/g, '-')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(model, null, 2) + '\n');
    console.log(`wrote ${out}  (${sizeOf(model)} of Alexa's ${ALEXA_LIMIT} allowed intents + slots)`);
}

module.exports = { buildModel, sizeOf, checkExtra, ALEXA_LIMIT };
