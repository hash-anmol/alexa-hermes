'use strict';
// Text -> mp3 for the spoken-answer stream. Kokoro (offline neural voice) runs in one long-lived Python worker;
// ffmpeg turns each sentence into a small mp3 that can be glued to the next one.
//
//   const audio = await createAudio(config)   // null when Kokoro/ffmpeg are not usable (the skill then falls back to text)
//   audio.speak('Hello.')  -> Promise<Buffer>   mp3, 24 kHz mono 48 kbps CBR (6000 bytes per second)
//   audio.silence(0.5)     -> Buffer
//   audio.chime()          -> Buffer             short "I heard you" tone
//   audio.softChime()      -> Buffer             very quiet tick, once a minute during long tasks
//
// All pieces use the same mp3 parameters and have no ID3/Xing header, so the Echo sees one continuous stream.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RATE = 24000;
const BITRATE = '48k';
const BYTES_PER_SEC = 6000; // 48 kbps / 8
const WORKER = path.join(__dirname, 'tts_worker.py');

const expand = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());
const MP3_OUT = ['-c:a', 'libmp3lame', '-b:a', BITRATE, '-ar', String(RATE), '-ac', '1', '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', 'pipe:1'];

function ffmpeg(args, bin = 'ffmpeg') {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [];
        let err = '';
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-200)}`))));
    });
}

// Starts the worker and waits for it to load the model. Resolves { call(text) -> wav path, close() }.
function startWorker(sp, log) {
    const model = expand(sp.model || '~/.kokoro/kokoro-v0_19.onnx');
    const voices = expand(sp.voices || '~/.kokoro/voices.bin');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-claude-tts-'));
    const child = spawn(sp.python || 'python3', [WORKER, model, voices, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map();
    let nextId = 1;
    let buf = '';
    let alive = true;
    let onReady;
    const ready = new Promise((res, rej) => {
        onReady = res;
        child.on('error', rej);
        setTimeout(() => rej(new Error('Kokoro did not start within 60 s')), 60000).unref();
    });
    const failAll = (e) => {
        for (const w of waiting.values()) w.reject(e);
        waiting.clear();
    };
    child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const raw = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!raw.startsWith('{')) continue;
            let m;
            try {
                m = JSON.parse(raw);
            } catch {
                continue;
            }
            if (m.ready) onReady();
            const w = waiting.get(m.id);
            if (w) {
                waiting.delete(m.id);
                m.error ? w.reject(new Error(m.error)) : w.resolve(m.file);
            }
        }
    });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
        alive = false;
        failAll(new Error(`tts worker exited (${code})`));
        log && log(`tts worker exited (${code})`);
    });
    return ready.then(() => ({
        alive: () => alive,
        call: (text, opts) =>
            new Promise((resolve, reject) => {
                const id = nextId++;
                waiting.set(id, { resolve, reject });
                child.stdin.write(JSON.stringify({ id, text, voice: opts.voice, lang: opts.lang, speed: opts.speed }) + '\n');
            }),
        close: () => {
            try {
                child.kill();
            } catch {
                /* already gone */
            }
        },
    }));
}

async function createAudio(config, { log = () => {} } = {}) {
    const sp = (config.skill && config.skill.speech) || {};
    if (sp.enabled === false) return null;
    try {
        await ffmpeg(['-version']);
        let worker = await startWorker(sp, log);
        const opts = { voice: sp.voice || 'bf_emma', lang: sp.lang || 'en-gb', speed: sp.speed || 1.0 };

        const silenceCache = new Map();
        const silence = (sec) => {
            if (!silenceCache.has(sec)) silenceCache.set(sec, null);
            return silenceCache.get(sec);
        };
        // build the fixed pieces once
        const make = async (sec) => silenceCache.set(sec, await ffmpeg(['-f', 'lavfi', '-i', `anullsrc=r=${RATE}:cl=mono`, '-t', String(sec), ...MP3_OUT]));
        await make(0.5);
        const chimeBuf = await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.14', '-af', 'afade=t=out:st=0.06:d=0.08,volume=0.5', ...MP3_OUT]);

        // one sentence at a time through Kokoro (it is a single worker); callers chain their requests
        const speak = async (text) => {
            if (!worker.alive()) worker = await startWorker(sp, log);
            const wav = await worker.call(text, opts);
            try {
                return await ffmpeg(['-i', wav, '-af', 'apad=pad_dur=0.12', ...MP3_OUT]);
            } finally {
                fs.unlink(wav, () => {});
            }
        };
        // Barely-there tick for "still working" every minute during a long task.
        const softBuf = await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.28', '-af', 'afade=t=in:st=0:d=0.08,afade=t=out:st=0.1:d=0.18,volume=0.1', ...MP3_OUT]);
        return { speak, silence, chime: () => chimeBuf, softChime: () => softBuf, close: () => worker.close(), BYTES_PER_SEC };
    } catch (e) {
        log(`spoken answers unavailable: ${e.message}`);
        return null;
    }
}

module.exports = { createAudio, BYTES_PER_SEC };
