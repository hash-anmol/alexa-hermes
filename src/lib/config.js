'use strict';
// Paths and config loading shared by everything in src/.
// Environment overrides (tests and unusual installs):
//   ALEXA_HERMES_CONFIG  path to config.json            (default: <repo>/config.json)
//   ALEXA_HERMES_DATA    where runtime state is kept    (default: <repo>/data)
//   ALEXA_HERMES_AUDIO   folder holding the alarm mp3   (default: <repo>/audio)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_FILE = process.env.ALEXA_HERMES_CONFIG || path.join(ROOT, 'config.json');
const DATA_DIR = process.env.ALEXA_HERMES_DATA || path.join(ROOT, 'data');
const AUDIO_DIR = process.env.ALEXA_HERMES_AUDIO || path.join(ROOT, 'audio');

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function timezone(cfg = loadConfig()) {
    return cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

module.exports = { ROOT, CONFIG_FILE, DATA_DIR, AUDIO_DIR, loadConfig, timezone };
