# Troubleshooting

Always start with:

```bash
node bin/alexa-hermes.js doctor
node bin/alexa-hermes.js ask "say hello"        # is Hermes reachable at all?
journalctl --user -u alexa-hermes -f           # what Alexa is sending (systemd)
```

## Alexa says "There was a problem with the requested skill's response"

Alexa could not get a valid answer from your server.

- Is the server running? `curl http://127.0.0.1:8787/health` should print `ok`.
- Is the public address up? `curl https://<publicBase>/health`.
- The log says `refused request: signature check failed`: a request that did not come from Alexa (or an old tunnel address). Harmless unless *every* request fails.
- The log says `refused request from skill id "amzn1…"`: `skill.applicationId` in `config.json` is wrong or empty. Paste the id of the skill you are testing.

## "I missed that" / the fallback line

The sentence started with a word the model does not list. Start differently (*check…, show…, find…, what…, how…, please…*), or say *"open Hermes"* first. See [VOICE-COMMANDS.md](VOICE-COMMANDS.md).

## Alexa answers with text but nothing plays / "Hermes here" but no spoken answer

- **Build > Interfaces > Audio Player** must be on, then **Build skill**.
- The log line `answers: text replies` means spoken answers are off: install the voice (`./setup.sh --voice`), check `doctor` for ffmpeg and Kokoro.
- The simulator in the console does not play audio; test on the Echo.

## The build fails: "total number of slots and intents … exceeds the limit of 350"

You added intents or opening words. Regenerate the model with `node bin/alexa-hermes.js model` (it prints the count) and paste it again.

## The skill is not on my Echo

- The developer account and the Echo must be the same Amazon account.
- Console > Test > *Skill testing is enabled in* must be **Development**.
- Say *"Alexa, open Hermes"* using the exact invocation name.

## Hermes problems

| What you hear / see | Cause and fix |
|---|---|
| "I can't reach Hermes" | local: `hermes` not found, set `hermes.bin`. ssh: `ssh <host> true` needs a password or prompt; gateway: wrong `hermes.url` or the gateway is down. |
| "Tailscale wants you to approve SSH again" | Tailscale SSH is in *check* mode: set the rule to `accept`, or use gateway mode. |
| "The Hermes gateway rejected the API key" | `hermes.token` must equal `API_SERVER_KEY` on the Hermes machine. |
| "Hermes wanted permission to run something" | Gateway approvals are on. Set `approvals: { mode: off }` on the Hermes machine, or run commands that do not need approval. |
| "Hermes took too long" | raise `hermes.timeoutMs`, or ask for something smaller. |
| "The AI model is rate limited or out of credit" | Hermes' model provider. Check Hermes itself. |
| "Hermes isn't installed where I expected it" | the `hermes.bin` path is wrong (use an absolute path over ssh). |

## Health commands say they cannot run

The health report uses Linux tools (`df`, `free`, `/proc/loadavg`, `ps`, `systemctl`). On macOS they are unavailable; everything else works.

## Spoken answers sound wrong or are slow

`skill.speech.voice` (the default is the British female `bf_emma`; others in the downloaded voice file include `bf_isabella`, `bm_george`, `af_sarah`, `am_adam`), `speed`, `lang` (`en-us`, `en-gb`). The first sentence has a short delay while Kokoro warms up; a CPU with 2+ cores is plenty.
