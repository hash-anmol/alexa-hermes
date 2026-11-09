'use strict';
// HTTP side of the private Alexa skill. Run by systemd (alexa-hermes.service) or `alexa-hermes start`, published to
// Alexa through any public HTTPS tunnel (Tailscale Funnel, Cloudflare Tunnel, ngrok, a reverse proxy) that forwards to
// http://127.0.0.1:<port>.
//
//   POST /alexa                       Alexa requests. Signature, timestamp and skill id are checked; anything else is refused.
//   GET  /audio/<secret>/<file.mp3>   the alarm sound (the secret stops strangers from downloading it); supports Range
//   GET  /health                      "ok"
//
// Security: the Funnel URL is public, and Alexa signs requests from EVERY skill, so config.skill.applicationId
// (your skill's id from the Alexa console) is mandatory: without it every request is refused.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, DATA_DIR, AUDIO_DIR } = require('./lib/config');
const { handle } = require('./handlers');
const state = require('./state');

const TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
const MAX_BODY = 1024 * 1024;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Secret path segment for the audio URL. From config, else generated once and kept in the data dir.
function audioSecret(config) {
    if (config.skill && config.skill.audioToken) return String(config.skill.audioToken);
    const file = path.join(DATA_DIR, 'skill-audio-token');
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        const t = crypto.randomBytes(18).toString('hex');
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(file, t, { mode: 0o600 });
        return t;
    }
}

const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error('body too large'));
                req.destroy();
            } else chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function defaultVerify(req, raw) {
    const verifier = (await import('alexa-verifier')).default; // ESM-only package
    try {
        await verifier(req.headers.signaturecertchainurl, req.headers['signature-256'] || req.headers.signature, raw);
    } catch (e) {
        throw new Error(`signature check failed: ${e && e.message ? e.message : e}`);
    }
}

function serveAudio(req, res, config, secret, audioDir) {
    const m = /^\/audio\/([^/]+)\/([^/]+)$/.exec(req.url.split('?')[0]);
    if (!m || !same(decodeURIComponent(m[1]), secret)) return reply(res, 404, 'not found');
    const name = path.basename(decodeURIComponent(m[2]));
    const type = TYPES[path.extname(name).toLowerCase()];
    const file = path.join(audioDir, name);
    if (!type || !fs.existsSync(file)) return reply(res, 404, 'not found');

    const size = fs.statSync(file).size;
    const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        let end = range[1] && range[2] ? Number(range[2]) : size - 1;
        end = Math.min(end, size - 1);
        if (start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
        }
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        return req.method === 'HEAD' ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
}

function reply(res, code, body, type = 'text/plain') {
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
}

// opts: { config, askHermes, voice, health, yolo, verify, insecure, audioDir, now, log }
//   voice: createVoice(...) from voice.js. When set, questions are answered with a live spoken stream (GET /voice/<secret>/<id>.mp3).
function createServer(opts) {
    const config = opts.config;
    const log = opts.log || ((m) => console.log(`[${stamp()}] ${m}`));
    const now = opts.now || Date.now;
    const verify = opts.verify || defaultVerify;
    const audioDir = opts.audioDir || AUDIO_DIR;
    const secret = audioSecret(config);
    const sk = config.skill || {};

    return http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];
        try {
            if (req.method === 'GET' && url === '/health') return reply(res, 200, 'ok');
            if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/audio/')) return serveAudio(req, res, config, secret, audioDir);
            if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/voice/')) {
                const m = /^\/voice\/([^/]+)\/([a-f0-9]+)\.mp3$/.exec(url);
                if (!opts.voice || !m || !same(decodeURIComponent(m[1]), secret) || !opts.voice.attach(m[2], req, res)) return reply(res, 404, 'not found');
                return;
            }
            if (req.method !== 'POST' || (url !== '/alexa' && url !== '/')) return reply(res, 404, 'not found');

            const raw = await readBody(req);
            if (!opts.insecure) {
                try {
                    await verify(req, raw);
                } catch (e) {
                    log(`refused request: ${e.message}`);
                    return reply(res, 400, 'bad signature');
                }
            }
            let envelope;
            try {
                envelope = JSON.parse(raw);
            } catch {
                return reply(res, 400, 'bad json');
            }
            const appId =
                (envelope.session && envelope.session.application && envelope.session.application.applicationId) ||
                (envelope.context && envelope.context.System && envelope.context.System.application && envelope.context.System.application.applicationId);
            // One Alexa skill per Hermes profile ("ask Sally", "ask Eddie"), all pointing at this endpoint.
            // skill.profiles maps a skill id to the Hermes profile that answers it; skill.applicationId is the default one.
            const profiles = sk.profiles || {};
            const known = appId && (appId === sk.applicationId || Object.prototype.hasOwnProperty.call(profiles, appId));
            if (!opts.insecure && !known) {
                log(`refused request from skill id "${appId}"${sk.applicationId ? '' : ' (set skill.applicationId in config.json to your skill id)'}`);
                return reply(res, 403, 'wrong skill');
            }

            const t0 = Date.now();
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            const ctx = {
                config,
                askHermes: opts.askHermes,
                defaultSound: () => {
                    if (sk.alarmSound && fs.existsSync(path.join(audioDir, sk.alarmSound))) return sk.alarmSound;
                    try {
                        return fs.readdirSync(audioDir).find((f) => TYPES[path.extname(f).toLowerCase()]) || null;
                    } catch {
                        return null;
                    }
                },
                voice: opts.voice,
                profile: Object.prototype.hasOwnProperty.call(profiles, appId) ? profiles[appId] : undefined,
                health: opts.health,
                yolo: opts.yolo,
                voiceUrl: (id) => `${sk.publicBase || `https://${host}`}/voice/${secret}/${id}.mp3`,
                state: opts.state || state,
                now,
                log,
                audioUrl: (file) => `${sk.publicBase || `https://${host}`}/audio/${secret}/${encodeURIComponent(file)}`,
            };
            const out = await handle(envelope, ctx);
            const r = envelope.request || {};
            log(`${r.type}${r.intent ? ' ' + r.intent.name : ''} -> ${Date.now() - t0}ms`);
            return reply(res, 200, JSON.stringify(out), 'application/json;charset=UTF-8');
        } catch (e) {
            log(`error: ${e.stack || e.message}`);
            const fallback = { version: '1.0', response: { outputSpeech: { type: 'PlainText', text: 'Something went wrong on my side.' }, shouldEndSession: true } };
            return reply(res, 200, JSON.stringify(fallback), 'application/json;charset=UTF-8');
        }
    });
}

async function main() {
    const config = loadConfig();
    const sk = config.skill || {};
    if (sk.enabled === false) {
        console.log('skill disabled in config.json');
        return;
    }
    const { askHermes } = require('./hermes-client');

    // Spoken answer stream (Kokoro voice + ffmpeg on this machine). Without them the skill falls back to the text answers above.
    let voice = null;
    const audio = await require('./tts').createAudio(config, { log: (m) => console.log(`[${stamp()}] ${m}`) });
    if (audio) {
        const { createVoice } = require('./voice');
        const { streamHermes, sendMessage } = require('./hermes-client');
        // `hermes send` (the Slack/Telegram hand-off) needs the Hermes CLI, so it is not available through a remote gateway.
        const notify = config.hermes && config.hermes.notifyTarget && config.hermes.mode !== 'gateway' ? (text) => sendMessage(text) : null;
        voice = createVoice({ audio, streamHermes, state, config, notify, log: (m) => console.log(`[${stamp()}] ${m}`) });
    }
    console.log(`[${stamp()}] hermes mode: ${(config.hermes && config.hermes.mode) || 'local'}`);
    console.log(`[${stamp()}] answers: ${voice ? 'spoken live as a stream (Kokoro voice)' : 'text replies, slow ones kept for "give me the answer"'}`);

    const yolo = require('./lib/yolo');
    const server = createServer({
        config,
        askHermes: (text, o) => askHermes(text, o),
        voice,
        health: require('./health').createHealth({ config }),
        yolo: { isOn: () => yolo.isOn(config.hermes || {}), set: yolo.set },
    });
    const port = sk.port || 8787;
    server.listen(port, '127.0.0.1', () => {
        console.log(`[${stamp()}] skill server on http://127.0.0.1:${port}${sk.applicationId ? '' : '  (WARNING: skill.applicationId not set, every Alexa request will be refused)'}`);
    });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createServer, audioSecret, main };
