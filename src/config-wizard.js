'use strict';
// Builds config.json from a few answers. Pure functions (tested); the questions themselves live in cli.js.

const PLACEHOLDER_ID = 'amzn1.ask.skill.PASTE-YOUR-SKILL-ID';

const clean = (v) => (v == null ? '' : String(v).trim());

// answers: { mode, bin, ssh, url, token, profile, session, yolo, notifyTarget, invocation, skillId, publicBase, port }
function buildConfig(a = {}) {
    const mode = ['local', 'ssh', 'gateway'].includes(clean(a.mode)) ? clean(a.mode) : 'local';
    const hermes = { mode, session: clean(a.session) || 'alexa', timeoutMs: 90000, yolo: a.yolo === true };
    if (mode === 'local') hermes.bin = clean(a.bin) || 'hermes';
    if (mode === 'ssh') {
        if (!clean(a.ssh)) throw new Error('ssh mode needs the ssh host (an alias from ~/.ssh/config, or user@host)');
        hermes.ssh = clean(a.ssh);
        hermes.bin = clean(a.bin) || 'hermes'; // an absolute path is safer over ssh: its PATH is minimal
    }
    if (mode === 'gateway') {
        const url = clean(a.url);
        if (!/^https?:\/\//.test(url)) throw new Error('gateway mode needs the gateway address, like http://hermes-box:8642');
        hermes.url = url.replace(/\/+$/, '');
        if (clean(a.token)) hermes.token = clean(a.token);
    }
    if (clean(a.profile) && clean(a.profile) !== 'default') hermes.profile = clean(a.profile);
    if (clean(a.notifyTarget) && mode !== 'gateway') hermes.notifyTarget = clean(a.notifyTarget);

    const port = Number(a.port) || 8787;
    const publicBase = clean(a.publicBase).replace(/\/+$/, '');
    return {
        hermes,
        skill: {
            invocation: (clean(a.invocation) || 'hermes').toLowerCase(),
            applicationId: clean(a.skillId) || PLACEHOLDER_ID,
            publicBase: publicBase || 'https://YOUR-PUBLIC-HOST',
            port,
            conversation: true,
            fastReplyMs: 6000,
            alarmSound: 'alarm.mp3',
            maxRingMinutes: 30,
            profiles: {},
            extraPhrases: {},
            speech: { enabled: true, voice: 'bf_emma', lang: 'en-gb', speed: 1.0, foregroundSec: 900, maxMinutes: 45 },
        },
        health: { bridgeName: 'the bridge', hermesName: 'the Hermes machine' },
    };
}

const isPlaceholder = (v) => !v || /PASTE|YOUR-|YOUR_/.test(String(v));

module.exports = { buildConfig, isPlaceholder, PLACEHOLDER_ID };
