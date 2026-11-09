'use strict';
// Turns the ugly errors from ssh / Hermes / the model provider into one plain sentence a speaker can say.
//   explain(err) -> { kind, spoken, detail }
// `kind` is stable (for logs and tests), `spoken` is what you hear, `detail` is the raw message (first 200 chars).

const RULES = [
    [
        'tailscale',
        /Tailscale SSH requires an additional check|login\.tailscale\.com\/a\//i,
        'Tailscale wants you to approve SSH again. Approve the link it sent, or switch the SSH rule from check to accept so it stops asking.',
    ],
    [
        'gateway-auth',
        /Hermes gateway (401|403)/i,
        'The Hermes gateway rejected the API key. Check hermes.token in config.json against API_SERVER_KEY on the Hermes machine.',
    ],
    [
        'approval',
        /needs approval for a command/i,
        'Hermes wanted permission to run something. Turn on YOLO mode on the Hermes gateway, then ask again.',
    ],
    [
        'unreachable',
        /port 22.*(timed out|refused)|Connection (timed out|refused|reset|closed)|No route to host|Could not resolve hostname|Network is unreachable|Host key verification|Permission denied \(publickey|ECONNREFUSED|ENOTFOUND|fetch failed|EHOSTUNREACH/i,
        "I can't reach Hermes. The machine may be off, or the network or VPN may be down.",
    ],
    ['timeout', /^timed out after|run.?budget|max.?turns/i, 'Hermes took too long, so I stopped it.'],
    ['quota', /\b429\b|rate.?limit|quota|insufficient.{0,20}(credit|fund|balance)|billing|out of credit/i, 'The AI model is rate limited or out of credit.'],
    ['auth', /\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?key|token)|expired.{0,20}(key|token)|authentication/i, "The AI model rejected Hermes' login. An API key may have expired."],
    ['model', /overloaded|\b5\d\d\b|bad gateway|service unavailable|upstream|provider|model.{0,20}(error|unavailable|not found)/i, 'The AI model provider returned an error.'],
    ['missing', /ENOENT|command not found/i, "Hermes isn't installed where I expected it."],
    ['silent', /no reply|empty reply|returned no/i, "Hermes didn't say anything back."],
    ['cancelled', /^cancelled$/i, 'Okay, I stopped it.'],
];

function explain(err) {
    const text = String((err && err.message) || err || '');
    for (const [kind, re, spoken] of RULES) if (re.test(text)) return { kind, spoken, detail: text.slice(0, 200) };
    return { kind: 'unknown', spoken: 'Something went wrong with Hermes.', detail: text.slice(0, 200) };
}

module.exports = { explain };
