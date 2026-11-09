'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');

const { buildConfig } = require('../src/config-wizard');
const { runChecks, format } = require('../src/doctor');

const BIN = path.join(__dirname, '..', 'bin', 'alexa-hermes.js');

test('buildConfig: local, ssh and gateway modes each get only the keys they need', () => {
    const local = buildConfig({ mode: 'local' });
    assert.deepEqual([local.hermes.mode, local.hermes.bin, local.hermes.ssh, local.hermes.url], ['local', 'hermes', undefined, undefined]);
    assert.equal(local.hermes.yolo, false, 'safe by default: Hermes may ask permission');

    const ssh = buildConfig({ mode: 'ssh', ssh: 'me@box', bin: '/home/me/.local/bin/hermes', notifyTarget: 'slack:Me' });
    assert.deepEqual([ssh.hermes.ssh, ssh.hermes.bin, ssh.hermes.notifyTarget], ['me@box', '/home/me/.local/bin/hermes', 'slack:Me']);
    assert.throws(() => buildConfig({ mode: 'ssh' }), /ssh host/);

    const gw = buildConfig({ mode: 'gateway', url: 'http://box:8642/', token: 'k', notifyTarget: 'slack:Me', profile: 'sally' });
    assert.deepEqual([gw.hermes.url, gw.hermes.token, gw.hermes.profile], ['http://box:8642', 'k', 'sally']);
    assert.equal(gw.hermes.notifyTarget, undefined, '`hermes send` needs the CLI, so no notify target through a gateway');
    assert.equal(gw.hermes.bin, undefined);
    assert.throws(() => buildConfig({ mode: 'gateway', url: 'box' }), /gateway address/);

    assert.match(buildConfig({}).skill.applicationId, /PASTE/);
    assert.equal(buildConfig({ invocation: 'Jarvis' }).skill.invocation, 'jarvis');
});

test('doctor, local mode: a working Hermes passes, a missing one says how to fix it', async () => {
    const fetchFn = async (url) => (url.endsWith('/health') ? { ok: true, status: 200, text: async () => 'ok' } : { ok: true, status: 200, text: async () => '' });
    const good = await runChecks(buildConfig({ mode: 'local', skillId: 'amzn1.ask.skill.abc', publicBase: 'https://x.example' }), {
        exec: async (bin, args) => ({ code: 0, out: bin === 'hermes' ? 'Hermes Agent v0.22.5' : 'ok', err: '' }),
        fetchFn,
        audioDir: os.tmpdir(),
    });
    const by = (rs, n) => rs.find((r) => r.name === n);
    assert.equal(by(good, 'Hermes (local)').status, 'pass');
    assert.equal(by(good, 'Alexa skill id').status, 'pass');
    assert.equal(by(good, 'Public HTTPS address').status, 'pass');

    const bad = await runChecks(buildConfig({ mode: 'local' }), { exec: async () => ({ code: -1, out: '', err: 'spawn hermes ENOENT' }), fetchFn: async () => { throw new Error('connect ECONNREFUSED'); }, audioDir: os.tmpdir() });
    assert.equal(by(bad, 'Hermes (local)').status, 'fail');
    assert.match(by(bad, 'Hermes (local)').fix, /ssh.*gateway/);
    assert.equal(by(bad, 'Alexa skill id').status, 'fail');
    assert.equal(by(bad, 'Public HTTPS address').status, 'fail');
    assert.match(format(bad), /problems? to fix/);
});

test('doctor, gateway mode: checks /health and that the key is accepted', async () => {
    const seen = [];
    const fetchFn = async (url, opts = {}) => {
        seen.push([url, opts.headers && opts.headers.Authorization]);
        if (url.endsWith('/v1/models')) return { ok: opts.headers.Authorization === 'Bearer right', status: opts.headers.Authorization === 'Bearer right' ? 200 : 401, text: async () => '' };
        return { ok: true, status: 200, text: async () => 'ok' };
    };
    const exec = async () => ({ code: 1, out: '', err: '' });
    const rs = await runChecks(buildConfig({ mode: 'gateway', url: 'http://box:8642', token: 'right' }), { exec, fetchFn, audioDir: os.tmpdir() });
    assert.equal(rs.find((r) => r.name === 'Hermes gateway reachable').status, 'pass');
    assert.equal(rs.find((r) => r.name === 'Hermes gateway key').status, 'pass');
    const wrong = await runChecks(buildConfig({ mode: 'gateway', url: 'http://box:8642', token: 'wrong' }), { exec, fetchFn, audioDir: os.tmpdir() });
    assert.equal(wrong.find((r) => r.name === 'Hermes gateway key').status, 'fail');
    assert.ok(seen.some(([u, a]) => u === 'http://box:8642/v1/models' && a === 'Bearer right'));
});

test('doctor, ssh mode: runs the remote hermes --version with BatchMode (never a password prompt)', async () => {
    const calls = [];
    const exec = async (bin, args) => (calls.push([bin, args]), bin === 'ssh' ? { code: 0, out: 'Hermes Agent v0.22.5', err: '' } : { code: 1, out: '', err: '' });
    const rs = await runChecks(buildConfig({ mode: 'ssh', ssh: 'box', bin: '/h/hermes' }), { exec, fetchFn: async () => { throw new Error('x'); }, audioDir: os.tmpdir() });
    assert.equal(rs.find((r) => r.name === 'Hermes over ssh').status, 'pass');
    const ssh = calls.find(([b]) => b === 'ssh')[1];
    assert.ok(ssh.includes('BatchMode=yes') && ssh.includes('box'));
    assert.match(ssh[ssh.length - 1], /\/h\/hermes --version/);
});

test('the CLI: init writes a private config.json, refuses to overwrite, and model writes a valid model under the limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cli-'));
    const env = { ...process.env, ALEXA_HERMES_CONFIG: path.join(dir, 'config.json'), ALEXA_HERMES_DATA: path.join(dir, 'data') };
    const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input: '' });

    const init = run('init', '--yes', '--mode', 'gateway', '--url', 'http://box:8642', '--token', 'secret', '--invocation', 'Jarvis');
    assert.equal(init.status, 0, init.stderr);
    const cfg = JSON.parse(fs.readFileSync(env.ALEXA_HERMES_CONFIG, 'utf8'));
    assert.equal(cfg.hermes.mode, 'gateway');
    assert.equal(cfg.skill.invocation, 'jarvis');
    if (process.platform !== 'win32') assert.equal(fs.statSync(env.ALEXA_HERMES_CONFIG).mode & 0o077, 0, 'config.json holds the key: owner only');
    assert.notEqual(run('init', '--yes').status, 0, 'does not overwrite');
    assert.equal(run('init', '--yes', '--force', '--mode', 'local').status, 0);

    const out = path.join(dir, 'm.json');
    const model = run('model', 'jarvis', out);
    assert.equal(model.status, 0, model.stderr);
    assert.match(model.stdout, /of the 350 intents \+ slots/);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).interactionModel.languageModel.invocationName, 'jarvis');

    assert.match(run('help').stdout, /alexa-hermes/);
    assert.notEqual(run('nonsense').status, 0);
});

test('nothing audio is tracked or ignored the wrong way: the alarm mp3 can never be committed', () => {
    const root = path.join(__dirname, '..');
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const ext of ['mp3', 'm4a', 'wav']) assert.match(ignore, new RegExp(`\\*\\.${ext}`));
    assert.match(ignore, /audio\/\*/);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.git' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    // anything sitting in audio/ is the user's own file; only the placeholder may be committed
    const tracked = (() => {
        try {
            return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
        } catch {
            return walk(root).map((f) => path.relative(root, f)).filter((f) => !f.startsWith('audio' + path.sep));
        }
    })();
    assert.deepEqual(tracked.filter((f) => /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f)), []);
});
