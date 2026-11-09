'use strict';
// YOLO mode = Hermes runs `--yolo`: it never stops to ask permission for a command.
// The default comes from config.json -> hermes.yolo; "turn on/off yolo mode" by voice (or `node core/lib/yolo.js on|off`)
// writes a small state file that wins over the config until changed again.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const file = () => path.join(DATA_DIR, 'hermes-yolo.json');

function isOn(hermesCfg = {}) {
    try {
        const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (typeof j.on === 'boolean') return j.on;
    } catch {
        /* no override yet */
    }
    return !!hermesCfg.yolo;
}

function set(on) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ on: !!on, at: Date.now() }));
    return !!on;
}

if (require.main === module) {
    const { loadConfig } = require('./config');
    const arg = process.argv[2];
    if (arg === 'on' || arg === 'off') set(arg === 'on');
    console.log(`yolo is ${isOn(loadConfig().hermes) ? 'ON' : 'off'}`);
}

module.exports = { isOn, set };
