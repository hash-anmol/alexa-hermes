# Alexa Hermes

**Talk to your [Hermes](https://github.com/NousResearch/hermes-agent) agent through an Alexa speaker.**

Say *"Alexa, ask Hermes what's on my plate today"*. A private Alexa skill sends the sentence to your Hermes agent. Hermes works, and its answer is **spoken back live** as it is written: *"I'll check your calendar… you have two meetings."* Long tasks keep going in the background.

```
Echo ──▶ Alexa cloud ──▶ your public HTTPS address ──▶ alexa-hermes (this repo) ──▶ Hermes
                         (Tailscale Funnel,               skill server              local · ssh · gateway
                          Cloudflare Tunnel, ngrok…)
Echo ◀── live mp3 stream (Kokoro voice, made on your machine) ◀────────────────────────┘
```

Nothing is installed on the Echo and nothing is flashed. The skill is **private**: it exists only in your own Alexa developer account, on Echos signed in to that account.

## Three ways to reach Hermes

| Mode | Hermes runs… | How it connects | Use it when |
|---|---|---|---|
| **`local`** | on the same machine as this bridge | runs the `hermes` command | one box does everything (a home server, a Pi, a VPS) |
| **`ssh`** | on another machine you can `ssh` into | `ssh host hermes chat …` | Hermes lives on a cloud VM, the bridge at home |
| **`gateway`** | on another machine with the Hermes **API server** on | HTTP to Hermes' OpenAI-compatible `/v1/chat/completions` | you would rather expose one authenticated port than give ssh access |

Details, trade-offs and setup for each: [docs/MODES.md](docs/MODES.md).

## Quick start

You need: Node.js 18+, a Hermes install somewhere, an Echo (or any Alexa device) and an [Amazon developer account](https://developer.amazon.com/alexa/console/ask) (free) signed in with the **same Amazon account as the Echo**.

```bash
git clone https://github.com/hash-anmol/alexa-hermes.git
cd alexa-hermes
./setup.sh --voice --service          # asks where Hermes runs; installs the offline voice and a systemd service
node bin/alexa-hermes.js ask "say hello in five words"    # tests the Hermes connection
```

Then, once:

1. **Public HTTPS address** for the server: [docs/TUNNELS.md](docs/TUNNELS.md) (Tailscale Funnel is one command).
2. **Create the private skill** and paste the generated model: [docs/ALEXA-SKILL.md](docs/ALEXA-SKILL.md). `node bin/alexa-hermes.js model` writes it.
3. Put the **skill id** and **public address** into `config.json`, restart, and run `node bin/alexa-hermes.js doctor` until every line says PASS.

No flags? `./setup.sh` asks questions. Fully scripted example for a remote gateway:

```bash
./setup.sh --yes --mode gateway --url http://hermes-box:8642 --token "$API_SERVER_KEY" --invocation hermes
```

## What you can say

After *"Alexa, ask Hermes …"* (or *"Alexa, open Hermes"* and then speak):

- **Anything.** Whatever you say goes to Hermes as the prompt: *"check my latest emails"*, *"remind me to call Sam at five"*, *"summarize the report in my downloads"*.
- **Long tasks:** *"any update"*, *"give me the answer"*, *"cancel the task"*.
- **Health:** *"server health"*, *"test the bridge"*, *"test the Hermes server"*.
- **Update Hermes:** *"update Hermes"*.
- **YOLO mode:** *"turn on yolo mode"* / *"turn off yolo mode"* / *"yolo mode status"*.
- **Alarm:** *"ring the alarm"* plays your own mp3 until you say *"stop"*; trigger it from an Alexa Routine.

Full list, and how free-form sentences get through Alexa's rules: [docs/VOICE-COMMANDS.md](docs/VOICE-COMMANDS.md). Several Hermes profiles, one skill each (*"ask Sally"*, *"ask Eddie"*): [docs/MODES.md](docs/MODES.md#profiles).

## Commands

```
alexa-hermes init               create config.json (local / ssh / gateway)
alexa-hermes doctor             check everything, explain every problem
alexa-hermes ask "question"     ask Hermes from the terminal
alexa-hermes model [name]       write the Alexa interaction model
alexa-hermes start              run the skill server
alexa-hermes service install    systemd user service (Linux)
alexa-hermes health [test|bridge|hermes|update|json]
alexa-hermes yolo on|off|status
```

## Safe by default

- **Only your skill is answered.** Every request must carry a valid Amazon signature and your skill id (`skill.applicationId`). Without the id set, everything is refused.
- **Hermes may ask permission** before running commands unless you turn YOLO on. Over a gateway, YOLO is the gateway's own `approvals.mode: off`.
- Spoken-answer and alarm URLs contain a random secret, so strangers cannot fetch your audio.
- `config.json` (which can hold a gateway key) is written readable by you only and is git-ignored.
- **No Amazon login, no scraping.** This project never signs in to your Amazon account.

More in [SECURITY.md](SECURITY.md).

## Requirements and limits

- **Linux** is the supported host (systemd service, health checks use `df`, `free`, `/proc`). macOS runs the skill and answers, but the health commands and `service install` are Linux-only.
- **Spoken answers** use the offline [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) voice (about 330 MB, CPU only) and `ffmpeg`. Without them the skill still works and answers in text, within Alexa's 8-second limit.
- Alexa builds a model with at most **350 intents + slots**. This project uses about 323 of them to let almost any sentence through; see [docs/VOICE-COMMANDS.md](docs/VOICE-COMMANDS.md).
- The skill stays in the **development stage** (private). Publishing it to the Alexa store is not supported.

## Troubleshooting

`node bin/alexa-hermes.js doctor` finds most problems. For the rest: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Development

```bash
npm install
npm test        # no network, no Hermes, no Alexa needed
```

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Amazon or Nous Research. Alexa is a trademark of Amazon.com, Inc.; Hermes Agent is a project of Nous Research.
