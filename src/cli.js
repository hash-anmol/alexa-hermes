'use strict';
// alexa-hermes: setup and day-to-day commands.
//   alexa-hermes init [flags]       write config.json (asks questions; flags skip them)
//   alexa-hermes doctor             check everything and say how to fix what is missing
//   alexa-hermes model [name]       write the Alexa interaction model for a skill to build/
//   alexa-hermes ask "question"     send one question to Hermes from the terminal (tests the Hermes connection)
//   alexa-hermes start              run the skill server
//   alexa-hermes service install    install a systemd user service (Linux) that runs the server
//   alexa-hermes health [test|bridge|hermes|update|json]
//   alexa-hermes yolo on|off|status

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { ROOT, CONFIG_FILE, loadConfig } = require('./lib/config');

const HELP = `alexa-hermes: talk to your Hermes agent through an Alexa speaker.

Usage: alexa-hermes <command>

  init                 create config.json (local, ssh or gateway Hermes)
  doctor               check the setup and explain any problem
  model [name]         write the Alexa interaction model (build/interaction-model.<name>.json)
  ask "question"       ask Hermes from the terminal
  start                run the skill server
  service install      install a systemd user service that runs the server
  health [test|bridge|hermes|update|json]
  yolo on|off|status   whether Hermes may run commands without asking

init flags (skip the questions):
  --mode local|ssh|gateway   --bin PATH   --ssh HOST   --url URL   --token KEY
  --profile NAME   --notify TARGET   --invocation NAME   --skill-id ID   --public-url URL
  --yolo   --force (overwrite an existing config.json)   --yes (use defaults, never ask)
`;

function parseFlags(argv) {
    const flags = {};
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            rest.push(a);
            continue;
        }
        const key = a.slice(2);
        if (['yolo', 'force', 'yes'].includes(key)) flags[key] = true;
        else flags[key] = argv[++i];
    }
    return { flags, rest };
}

const ask = (rl, q, def) =>
    new Promise((resolve) => rl.question(`${q}${def ? ` [${def}]` : ''}: `, (a) => resolve(a.trim() || def || '')));

async function init(argv) {
    const { buildConfig } = require('./config-wizard');
    const { flags } = parseFlags(argv);
    if (fs.existsSync(CONFIG_FILE) && !flags.force) {
        console.error(`${CONFIG_FILE} already exists. Edit it, or run: alexa-hermes init --force`);
        return 1;
    }
    const a = {
        mode: flags.mode, bin: flags.bin, ssh: flags.ssh, url: flags.url, token: flags.token, profile: flags.profile,
        notifyTarget: flags.notify, invocation: flags.invocation, skillId: flags['skill-id'], publicBase: flags['public-url'], yolo: !!flags.yolo,
    };
    if (!flags.yes && process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log('Where does your Hermes run?\n  local    on this machine\n  ssh      on another machine I can ssh into (no password prompt)\n  gateway  on another machine with the Hermes API server turned on');
        a.mode = a.mode || (await ask(rl, 'Mode', 'local'));
        if (a.mode === 'local') a.bin = a.bin || (await ask(rl, 'Path to the hermes command', 'hermes'));
        if (a.mode === 'ssh') {
            a.ssh = a.ssh || (await ask(rl, 'ssh host (alias or user@host)'));
            a.bin = a.bin || (await ask(rl, 'Full path of hermes on that machine', 'hermes'));
        }
        if (a.mode === 'gateway') {
            a.url = a.url || (await ask(rl, 'Gateway address', 'http://localhost:8642'));
            a.token = a.token || (await ask(rl, 'API_SERVER_KEY of that Hermes (the Hermes API server requires one)'));
        }
        a.profile = a.profile || (await ask(rl, 'Hermes profile (blank = default)'));
        a.invocation = a.invocation || (await ask(rl, 'Alexa invocation name (what you say after "ask")', 'hermes'));
        a.publicBase = a.publicBase || (await ask(rl, 'Public https address Alexa will call (blank = fill in later)'));
        a.skillId = a.skillId || (await ask(rl, 'Alexa skill id (blank = fill in after you create the skill)'));
        if (a.mode !== 'gateway') a.notifyTarget = a.notifyTarget || (await ask(rl, 'Where should I message you when a long task ends? e.g. slack:Your Name (blank = nowhere)'));
        if (!a.yolo) a.yolo = /^y/i.test(await ask(rl, 'YOLO mode: let Hermes run commands without asking permission? (y/N)', 'n'));
        rl.close();
    }
    let cfg;
    try {
        cfg = buildConfig(a);
    } catch (e) {
        console.error(e.message);
        return 1;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    console.log(`wrote ${CONFIG_FILE}`);
    console.log('Next: alexa-hermes ask "say hello"   (tests Hermes)   then   alexa-hermes doctor');
    return 0;
}

async function doctor() {
    const { runChecks, format } = require('./doctor');
    const results = await runChecks(loadConfig(), { configFile: CONFIG_FILE });
    console.log(format(results));
    return results.some((r) => r.status === 'fail') ? 1 : 0;
}

function model(argv) {
    const { buildModel, sizeOf, checkExtra, ALEXA_LIMIT } = require('./gen-model');
    const cfg = loadConfig();
    const inv = (argv[0] || (cfg.skill || {}).invocation || 'hermes').toLowerCase();
    const extra = (cfg.skill || {}).extraPhrases || {};
    for (const r of checkExtra(extra).rejected) console.warn(`skipped extra phrase: ${r}`);
    const m = buildModel(inv, { extraPhrases: extra });
    const out = argv[1] || path.join(ROOT, 'build', `interaction-model.${inv.replace(/\s+/g, '-')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
    console.log(`wrote ${out}  (${sizeOf(m)} of the ${ALEXA_LIMIT} intents + slots Alexa allows)`);
    console.log('Paste it into the Alexa console: Build > Interaction Model > JSON Editor, then Save and Build skill.');
    return 0;
}

async function askCmd(argv) {
    const text = argv.join(' ').trim();
    if (!text) {
        console.error('usage: alexa-hermes ask "your question"');
        return 1;
    }
    const { askHermes } = require('./hermes-client');
    const { explain } = require('./lib/errors');
    try {
        console.log(await askHermes(text));
        return 0;
    } catch (e) {
        const why = explain(e);
        console.error(`${why.spoken}\n(${why.detail})`);
        return 1;
    }
}

function serviceInstall() {
    if (process.platform !== 'linux') {
        console.error('service install writes a systemd unit, so it only works on Linux. On other systems run: alexa-hermes start');
        return 1;
    }
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const template = fs.readFileSync(path.join(ROOT, 'deploy', 'alexa-hermes.service'), 'utf8');
    const unit = template.replace(/%ROOT%/g, ROOT).replace(/%NODE%/g, process.execPath).replace(/%CONFIG%/g, CONFIG_FILE);
    const file = path.join(dir, 'alexa-hermes.service');
    fs.writeFileSync(file, unit);
    console.log(`wrote ${file}`);
    console.log('Start it now and on every boot:\n  systemctl --user daemon-reload\n  systemctl --user enable --now alexa-hermes\n  loginctl enable-linger $USER     # keeps it running when you are logged out');
    return 0;
}

async function main(argv) {
    const [cmd, ...rest] = argv;
    switch (cmd) {
        case 'init':
            return init(rest);
        case 'doctor':
            return doctor();
        case 'model':
            return model(rest);
        case 'ask':
            return askCmd(rest);
        case 'start':
            await require('./server').main();
            return new Promise(() => {}); // keep running: the HTTP server holds the process open
        case 'service':
            return rest[0] === 'install' ? serviceInstall() : (console.error('usage: alexa-hermes service install'), 1);
        case 'health': {
            const { createHealth } = require('./health');
            const h = createHealth({ config: loadConfig() });
            const mode = rest[0];
            const run = { test: () => h.test(), bridge: () => h.testBridge(), hermes: () => h.testHermes(), update: async () => ({ spoken: await h.updateHermes({ say: console.log }) }) }[mode] || (() => h.report());
            const r = await run();
            console.log(mode === 'json' ? JSON.stringify(r, null, 2) : r.spoken);
            return 0;
        }
        case 'yolo': {
            const yolo = require('./lib/yolo');
            if (rest[0] === 'on' || rest[0] === 'off') yolo.set(rest[0] === 'on');
            console.log(`yolo is ${yolo.isOn(loadConfig().hermes || {}) ? 'ON' : 'off'}`);
            return 0;
        }
        case undefined:
        case 'help':
        case '--help':
        case '-h':
            console.log(HELP);
            return 0;
        default:
            console.error(`unknown command: ${cmd}\n\n${HELP}`);
            return 1;
    }
}

module.exports = { main, parseFlags };
