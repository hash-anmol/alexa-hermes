'use strict';
// Instant, no-AI checks you can ask for by voice (and run in a terminal: alexa-hermes health [test|bridge|hermes|json]).
//   testBridge() / testHermes() / test():  is it up, what is eating memory, is Hermes answering   (a few seconds each)
//   updateHermes():  `hermes update --check`, then `--yes` on the Hermes machine, then verifies the version
//   report(): disk, memory, load and failed services on the bridge (this machine) and on the Hermes machine
// "Bridge" is the machine running this skill server. "Hermes machine" is where Hermes runs: the same machine in local mode,
// another one over ssh, or only a gateway URL (then only reachability and latency can be checked, not disk or memory).
// The checks use standard Linux tools (df, free, /proc/loadavg, ps, systemctl); on other systems they say they cannot run.
// Everything comes back as a short sentence plus the raw numbers. `exec` is injectable so tests need no machines.

const { spawn } = require('child_process');
const { explain } = require('./lib/errors');

const TIMEOUT_HERMES_MS = 6000;
const TIMEOUT_LOCAL_MS = 4000;
const gb = (mb) => Math.round((mb / 1024) * 10) / 10;

function defaultExec(bin, args, timeoutMs, signal) {
    return new Promise((resolve) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        if (signal) {
            const stop = () => {
                child.kill('SIGKILL');
                resolve({ code: null, out, err: `${err} cancelled`, cancelled: true });
            };
            if (signal.aborted) stop();
            else signal.addEventListener('abort', stop, { once: true });
        }
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ code: null, out, err: `${err} timed out after ${timeoutMs}ms`, timedOut: true });
        }, timeoutMs);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: -1, out, err: String(e.message) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
        });
    });
}

// ---- parsers (df -P /, free -m, /proc/loadavg) ----
function parseDisk(text) {
    const line = String(text).trim().split('\n').filter((l) => /\d+%/.test(l)).pop();
    if (!line) return null;
    const f = line.trim().split(/\s+/);
    const total = Number(f[1]);
    const avail = Number(f[3]);
    const pct = Number(String(f[4]).replace('%', ''));
    if (![total, avail, pct].every(Number.isFinite)) return null;
    return { usedPct: pct, freeGB: Math.round((avail / 1024 / 1024) * 10) / 10, totalGB: Math.round(total / 1024 / 1024) };
}
function parseMem(text) {
    const line = String(text).split('\n').find((l) => /^Mem:/.test(l.trim()));
    if (!line) return null;
    const f = line.trim().split(/\s+/);
    const total = Number(f[1]);
    const avail = Number(f[6] ?? f[3]);
    return Number.isFinite(total) && Number.isFinite(avail) ? { totalMB: total, availableMB: avail } : null;
}
// "TOPMEM" / "TOPCPU" blocks: lines of "<number> <process name>", already summed per name by the remote command.
function block(text, marker) {
    const lines = String(text).split('\n');
    const i = lines.findIndex((l) => l.trim() === marker);
    if (i < 0) return [];
    const out = [];
    for (const l of lines.slice(i + 1)) {
        const m = /^\s*(\d+)\s+(\S+)/.exec(l);
        if (!m) break;
        out.push({ name: m[2], n: Number(m[1]) });
    }
    return out;
}
const parseTop = (text) => block(text, 'TOPMEM').map((x) => ({ name: x.name, mb: Math.round(x.n / 1024) })).slice(0, 3);
// % of one core, measured over one second (a process using two cores shows about 200)
const parseTopCpu = (text) => block(text, 'TOPCPU').map((x) => ({ name: x.name, pct: x.n })).filter((x) => x.pct > 0).slice(0, 3);
// UPTIME / PROCS / SVCS / CONTAINERS / FAILED lines from DETAIL_CMD
function parseDetail(text) {
    const field = (k) => ((new RegExp(`^${k}[ \\t]*(.*)$`, 'm').exec(String(text)) || [])[1] || '').trim();
    const num = (k) => {
        const n = Number(field(k));
        return Number.isFinite(n) && field(k) !== '' ? n : null;
    };
    return {
        uptime: field('UPTIME').replace(/^up\s+/, ''),
        procs: num('PROCS'),
        services: num('SVCS'),
        containers: field('CONTAINERS').split(/\s+/).filter(Boolean),
        failedUnits: field('FAILED').split(/\s+/).filter((u) => /\.(service|timer|socket)$/.test(u)),
        topCpu: parseTopCpu(text),
    };
}
function parseSwap(text) {
    const line = String(text).split('\n').find((l) => /^Swap:/.test(l.trim()));
    if (!line) return null;
    const f = line.trim().split(/\s+/);
    const total = Number(f[1]);
    const used = Number(f[2]);
    return Number.isFinite(total) && total > 0 && Number.isFinite(used) ? { totalMB: total, usedMB: used } : null;
}
const TOP_CMD = "echo TOPMEM; ps -eo rss=,comm= | awk '{a[$2]+=$1} END{for(k in a) print a[k],k}' | sort -rn | head -3";
// What is running right now: uptime, process and service counts, containers, failed units and the busiest processes (top, 1 s sample).
const DETAIL_CMD = String.raw`echo UPTIME "$(uptime -p 2>/dev/null)"; echo PROCS $(ps -e --no-headers | wc -l); echo SVCS $(systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | wc -l); echo CONTAINERS $(docker ps --format '{{.Names}}' 2>/dev/null | head -12 | tr '\n' ' '); echo FAILED $(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | tr '\n' ' '); echo TOPCPU; top -bn2 -d1 -w512 2>/dev/null | awk '/^top -/{n++} n==2 && $1 ~ /^[0-9]+$/ {a[$12]+=$9} END{for(k in a) printf "%d %s\n", a[k], k}' | sort -rn | head -3; echo ENDCPU`;
const parseLoad = (text) => {
    const n = parseFloat(String(text).trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
};
const parseLoads = (text) => {
    const f = String(text).trim().split(/\s+/).slice(0, 3).map(parseFloat);
    return f.length === 3 && f.every(Number.isFinite) ? f : null;
};
const nice = (unit) => String(unit).replace(/\.service$/, '').replace(/[-_]+/g, ' ');

function createHealth({ config = {}, exec = defaultExec, fetchFn = (u, ms) => fetch(u, { signal: AbortSignal.timeout(ms) }) } = {}) {
    const h = config.hermes || {};
    const remote = (script, ms) =>
        h.mode === 'ssh'
            ? exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', h.ssh, script], ms)
            : exec('sh', ['-c', script], ms);
    const hbin = h.bin || 'hermes';
    const hc = config.health || {};
    const names = { bridge: hc.bridgeName || 'the bridge', hermes: hc.hermesName || 'the Hermes machine' };
    const cap = (t) => t[0].toUpperCase() + t.slice(1);
    const unitName = hc.serviceName || 'alexa-hermes';

    // Gateway mode: Hermes is only a URL. Ask its /health endpoint, which is all a remote client can see.
    async function gatewayHealth() {
        const t0 = Date.now();
        const base = String(h.url || '').replace(/\/+$/, '');
        if (!base) return { ok: false, ms: 0, error: { kind: 'config', spoken: 'The Hermes gateway address is not set.', detail: 'hermes.url missing' } };
        try {
            const res = await fetchFn(`${base}/health`, TIMEOUT_HERMES_MS);
            if (!res.ok) return { ok: false, ms: Date.now() - t0, error: { kind: 'gateway', spoken: `The Hermes gateway answered with an error, code ${res.status}.`, detail: `HTTP ${res.status}` } };
            return { ok: true, ms: Date.now() - t0, gateway: true };
        } catch (e) {
            return { ok: false, ms: Date.now() - t0, error: { kind: 'gateway', spoken: "I can't reach the Hermes gateway. It may be off, or the network may be down.", detail: String(e.message).slice(0, 200) } };
        }
    }

    async function hermesHost() {
        if (h.mode === 'gateway') return gatewayHealth();
        const t0 = Date.now();
        const script = `echo HEY_OK; df -P /; free -m; cat /proc/loadavg; echo CPUS $(nproc); echo HV "$(${hbin} --version 2>&1 | grep -m1 -E 'v?[0-9]+\.[0-9]+')"; ${TOP_CMD}; ${DETAIL_CMD}`;
        const r = await remote(script, TIMEOUT_HERMES_MS);
        if (r.code !== 0 || !/HEY_OK/.test(r.out)) {
            const why = r.timedOut ? 'Hermes server did not answer in time. It may be overloaded.' : null;
            const e = explain(`${r.err} ${r.out}`);
            return { ok: false, ms: Date.now() - t0, error: why ? { kind: 'slow', spoken: `${cap(names.hermes)} didn't answer in time. It may be overloaded.`, detail: r.err.slice(0, 200) } : e };
        }
        const cpus = Number((/CPUS\s+(\d+)/.exec(r.out) || [])[1]) || 1;
        const hv = (/HV\s+(.*)/.exec(r.out) || [])[1] || '';
        return {
            ok: true,
            ms: Date.now() - t0,
            disk: parseDisk(r.out),
            mem: parseMem(r.out),
            load: parseLoad((r.out.split('\n').find((l) => /^\d+\.\d+ \d+\.\d+/.test(l)) || '')),
            loads: parseLoads((r.out.split('\n').find((l) => /^\d+\.\d+ \d+\.\d+/.test(l)) || '')),
            ...parseDetail(r.out),
            swap: parseSwap(r.out),
            top: parseTop(r.out),
            cpus,
            hermes: (/v?\d+\.\d+(?:\.\d+)?/.exec(hv) || [null])[0],
        };
    }

    async function bridge() {
        const run = (cmd) => exec('sh', ['-c', cmd], TIMEOUT_LOCAL_MS);
        const [df, free, load, failed, skill, detail] = await Promise.all([
            run('df -P /'),
            run('free -m'),
            run('cat /proc/loadavg'),
            run('systemctl --user --failed --no-legend --plain 2>/dev/null; systemctl --failed --no-legend --plain 2>/dev/null'),
            run(`systemctl --user is-active ${unitName} 2>/dev/null`),
            run(DETAIL_CMD),
        ]);
        const cpus = Number((await run('nproc')).out.trim()) || 1;
        const top = parseTop((await run(TOP_CMD)).out);
        let funnel = null;
        const base = config.skill && config.skill.publicBase;
        if (base && /^https:\/\//.test(base) && !/YOUR-/.test(base)) {
            try {
                const res = await fetchFn(`${base}/health`, 3000);
                funnel = res.ok;
            } catch {
                funnel = false;
            }
        }
        return {
            ok: true,
            disk: parseDisk(df.out),
            mem: parseMem(free.out),
            swap: parseSwap(free.out),
            top,
            load: parseLoad(load.out),
            loads: parseLoads(load.out),
            cpus,
            ...parseDetail(detail.out),
            failed: String(failed.out).split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => /\.(service|timer|socket)$/.test(u)),
            skillActive: /^active/.test(skill.out.trim()),
            funnel,
        };
    }

    const loadWord = (load, cpus) => (load == null ? '' : load / cpus > 1.5 ? 'high' : load / cpus > 0.8 ? 'busy' : 'low');
    const size = (mb) => (mb >= 1024 ? `${gb(mb)} gigabytes` : `${mb} megabytes`);
    const list = (xs) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
    // Every figure below comes from the command output of that machine; nothing is a fixed value.
    const box = (name, b) => {
        const bits = [];
        if (b.disk) bits.push(`storage: ${b.disk.freeGB} of ${b.disk.totalGB} gigabytes free, ${b.disk.usedPct} percent used`);
        if (b.mem) {
            const used = b.mem.totalMB - b.mem.availableMB;
            bits.push(`memory: ${size(b.mem.availableMB)} available of ${size(b.mem.totalMB)}, ${size(used)} in use`);
        }
        if (b.swap) bits.push(`swap: ${size(b.swap.usedMB)} used of ${size(b.swap.totalMB)}`);
        if (b.load != null) {
            const trend = b.loads ? ` (over five minutes ${b.loads[1]}, fifteen minutes ${b.loads[2]})` : '';
            bits.push(`load ${b.load}${trend} on ${b.cpus} core${b.cpus === 1 ? '' : 's'}, ${loadWord(b.load, b.cpus)}`);
        }
        if (b.uptime) bits.push(`up ${b.uptime}`);
        if (b.procs != null) bits.push(`${b.procs} processes${b.services != null ? ` and ${b.services} services running` : ''}`);
        if (b.containers && b.containers.length) bits.push(`${b.containers.length} docker container${b.containers.length === 1 ? '' : 's'} running: ${list(b.containers)}`);
        if (b.topCpu && b.topCpu.length) bits.push(`busiest right now: ${b.topCpu.map((t) => `${t.name} ${t.pct} percent of a core`).join(', ')}`);
        if (b.top && b.top.length) bits.push(`most memory: ${b.top.map((t) => `${t.name} ${size(t.mb)}`).join(', ')}`);
        return `${name}: ${bits.join('; ')}.`;
    };

    // The issues list drives the first sentence, so the thing that is wrong is the first thing you hear.
    function issues(hm, az) {
        const out = [];
        if (hm.failed.length) out.push(`${hm.failed.length} service${hm.failed.length > 1 ? 's' : ''} failed on ${names.bridge}: ${hm.failed.map(nice).join(', ')}`);
        if (!hm.skillActive) out.push('the Alexa skill service is not running');
        if (hm.funnel === false) out.push("the public Alexa link isn't answering");
        if (hm.disk && hm.disk.usedPct >= 90) out.push(`the disk on ${names.bridge} is ${hm.disk.usedPct} percent full`);
        if (hm.mem && hm.mem.availableMB < 500) out.push(`${names.bridge} is low on memory`);
        if (!az.ok) out.push(az.error.spoken.replace(/\.$/, ''));
        else {
            if (az.disk && az.disk.usedPct >= 85) out.push(`the disk on ${names.hermes} is ${az.disk.usedPct} percent full`);
            if (az.mem && az.mem.availableMB < 500) out.push(`${names.hermes} is low on memory`);
            if (az.load != null && az.load / az.cpus > 1.5) out.push(`${names.hermes} is overloaded, load ${az.load} on ${az.cpus} cores`);
            if (!az.hermes && !az.gateway) out.push("Hermes didn't report a version");
        }
        return out;
    }

    const upVer = (v) => (v ? `version ${String(v).replace(/^v/, '')}` : '');

    // `hermes ...` on the Hermes machine (through ssh when Hermes lives elsewhere).
    const hermesCmd = (args, ms, signal) => {
        const line = `${hbin} ${args} 2>&1 | grep -v COMPOSIO_API_KEY; echo "EXIT=\${PIPESTATUS[0]}"`;
        return h.mode === 'ssh'
            ? exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=20', h.ssh, line], ms, signal)
            : exec('sh', ['-c', line], ms, signal);
    };
    const exitOf = (r) => Number((/EXIT=(\d+)/.exec(r.out) || [])[1] ?? (r.code === 0 ? 0 : 1));
    const lastLine = (r) => String(r.out).split('\n').map((l) => l.trim()).filter((l) => l && !/^EXIT=/.test(l)).pop() || String(r.err).trim().slice(-120);

    // Spoken progress while Hermes updates itself: check, update, verify. Every step is a real command.
    async function updateHermes({ say = () => {}, signal, timeoutMs = 20 * 60 * 1000 } = {}) {
        if (h.mode === 'gateway') return "I can't update Hermes through a remote gateway. Update it on the machine where it runs.";
        const v0 = await hermesHost();
        if (!v0.ok) return `I can't update Hermes. ${v0.error.spoken}`;
        say('Checking for a Hermes update.');
        const chk = await hermesCmd('update --check', 90000, signal);
        if (chk.cancelled) return 'Okay, I stopped the update check.';
        const text = String(chk.out);
        if (exitOf(chk) === 0 && /up to date/i.test(text)) return `Hermes is already up to date, ${upVer(v0.hermes)}.`.replace(', .', '.');
        if (exitOf(chk) !== 0) return `I couldn't check for updates: ${lastLine(chk)}`;
        say('An update is available. Updating Hermes now. This can take a few minutes.');
        const up = await hermesCmd('update --yes', timeoutMs, signal);
        if (up.cancelled) return 'Okay, I stopped. The update may be half done, so check Hermes.';
        if (up.timedOut) return 'The Hermes update took too long and was stopped. Check the server.';
        if (exitOf(up) !== 0) return `The Hermes update failed: ${lastLine(up)}`;
        const v1 = await hermesHost();
        const now = v1.ok && v1.hermes ? `Hermes is now ${upVer(v1.hermes)}${v0.hermes && v0.hermes !== v1.hermes ? `, it was ${String(v0.hermes).replace(/^v/, '')}` : ''}.` : 'Hermes has not confirmed its version yet.';
        return `Update done. ${now}`;
    }

    // Plain checks you can run any time. Everything below executes real commands on the machine it describes.
    async function testBridge() {
        const hm = await bridge();
        const found = [];
        if (!hm.skillActive) found.push('the Alexa skill service is not running');
        if (hm.funnel === false) found.push("the public Alexa link isn't answering");
        if (hm.failed.length) found.push(`${hm.failed.length} failed service${hm.failed.length > 1 ? 's' : ''}: ${hm.failed.map(nice).join(', ')}`);
        const lead = found.length ? `${cap(names.bridge)} is up, but ${found.join(', ')}.` : `${cap(names.bridge)} is up and the Alexa link is working.`;
        return { hm, spoken: `${lead} ${box(cap(names.bridge), hm)}` };
    }

    async function testHermes() {
        const az = await hermesHost();
        if (!az.ok) return { az, spoken: az.error.spoken };
        const secs = (az.ms / 1000).toFixed(1);
        if (az.gateway) return { az, spoken: `The Hermes gateway is up and answered in ${secs} seconds.` };
        const slow = az.load != null && az.load / az.cpus > 1.5 ? ` It is busy, load ${az.load} on ${az.cpus} cores, so replies will be slow.` : '';
        return { az, spoken: `${cap(names.hermes)} is up and Hermes ${upVer(az.hermes) ? `${upVer(az.hermes)} ` : ''}answered in ${secs} seconds.${slow} ${box(cap(names.hermes), az)}` };
    }

    return {
        parseDisk,
        parseMem,
        hermesHost,
        bridge,
        issues,
        updateHermes,
        testBridge,
        testHermes,
        async test() {
            const [hm, az] = await Promise.all([testBridge(), testHermes()]);
            return { hm: hm.hm, az: az.az, spoken: `${hm.spoken} ${az.spoken}` };
        },
        async report() {
            const [hm, az] = await Promise.all([bridge(), hermesHost()]);
            const found = issues(hm, az);
            const head = found.length ? `Heads up: ${found.join('; ')}.` : 'Everything is working.';
            const parts = [head, box(cap(names.bridge), hm)];
            parts.push(az.ok ? (az.gateway ? 'The Hermes gateway is reachable.' : `${box(cap(names.hermes), az)}${az.hermes ? ` Hermes ${upVer(az.hermes)} is installed.` : ''}`) : '');
            return { home: hm, az, issues: found, spoken: parts.filter(Boolean).join(' ') };
        },
    };
}

if (require.main === module) {
    const { loadConfig } = require('./lib/config');
    const health = createHealth({ config: loadConfig() });
    const mode = process.argv[2];
    const run = { test: () => health.test(), bridge: () => health.testBridge(), hermes: () => health.testHermes(), update: async () => ({ spoken: await health.updateHermes({ say: console.log }) }) }[mode] || (() => health.report());
    run().then((r) => console.log(mode === 'json' ? JSON.stringify(r, null, 2) : r.spoken));
}

module.exports = { createHealth, parseDisk, parseMem, parseLoad, parseLoads, parseTop, parseTopCpu, parseDetail, parseSwap };
