# Choosing how to reach Hermes

Set `hermes.mode` in `config.json`. Check any mode with `node bin/alexa-hermes.js ask "say hello"` and `node bin/alexa-hermes.js doctor`.

## `local`: Hermes is on this machine

```json
"hermes": { "mode": "local", "bin": "hermes", "session": "alexa", "yolo": false }
```

The bridge runs `hermes chat -Q --format stream-json …` and reads its event stream, so it hears *"I'll check your calendar"* and every tool call as they happen and can speak them.

- `bin`: the `hermes` command; use the full path if it is not on the service's `PATH` (`which hermes`).
- `session`: a named Hermes session, so follow-ups keep context. Leave it out for a fresh session every time.
- `yolo`: `true` adds `--yolo`, so Hermes never waits for permission. Also togglable by voice.
- `notifyTarget`: for example `"slack:Your Name"`. When a long task finishes in the background, the bridge messages you with `hermes send`.

## `ssh`: Hermes is on another machine

```json
"hermes": { "mode": "ssh", "ssh": "my-hermes-box", "bin": "/home/me/.local/bin/hermes", "session": "alexa" }
```

Same as local, run through `ssh -o BatchMode=yes <ssh> '<bin> chat …'`. Requirements:

- `ssh my-hermes-box true` must work **with no prompt** from the machine that runs the bridge (key login; an alias in `~/.ssh/config`).
- Use the **absolute path** for `bin`: ssh starts a shell with a minimal `PATH`.
- If you use Tailscale SSH in *check* mode it will ask you to re-approve in a browser every so often; switch the rule to `accept` for this machine pair, or use gateway mode.

## `gateway`: Hermes' own API server

Hermes can serve an OpenAI-compatible API. The bridge uses `POST /v1/chat/completions` with `stream: true`, and understands the `hermes.tool.progress` events, so spoken progress works here too.

On the **Hermes machine**, add to `~/.hermes/.env` and start the gateway:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=<a long random secret>
API_SERVER_HOST=0.0.0.0        # default is 127.0.0.1: only reachable from that machine
# then:
hermes gateway
```

(See Hermes' API server documentation for the current options.) On the **bridge**:

```json
"hermes": { "mode": "gateway", "url": "http://hermes-box:8642", "token": "<the same API_SERVER_KEY>", "session": "alexa" }
```

or leave `token` out and set the environment variable `HERMES_API_KEY` for the service.

Things that differ from local and ssh:

- **YOLO is the gateway's setting.** Set `approvals: { mode: off }` in the Hermes `config.yaml` if you want commands to run without asking. If Hermes asks for approval through the gateway, the bridge stops and says so instead of hanging.
- **No `hermes send`**, so no "message me when it's done": ask *"any update"* instead.
- **Health checks** can only see whether the gateway answers and how fast; disk and memory of the Hermes machine are not visible. *"Update Hermes"* is not available.
- **Security:** the API gives full tool access. Use a long key, and prefer a private network (Tailscale, WireGuard, a VPN) over the open internet.

## Profiles

A Hermes profile is a separate agent (its own memory, skills, persona). Alexa allows one invocation name per skill, so use **one skill per profile**, all pointing at the same server:

1. `node bin/alexa-hermes.js model sally` writes a model whose invocation name is `sally`.
2. Create a second skill in the Alexa console, invocation `sally`, paste that model, set the **same endpoint** (docs/ALEXA-SKILL.md).
3. Map its skill id to the profile in `config.json`:

```json
"skill": {
  "applicationId": "amzn1.ask.skill.<the main skill>",
  "profiles": { "amzn1.ask.skill.<the sally skill>": "sally" }
}
```

*"Alexa, ask Sally …"* now runs `hermes -p sally` (local, ssh) or the `/p/sally/` route (gateway; Hermes needs `gateway.multiplex_profiles`). Skills not listed in `profiles` use the default profile, or `hermes.profile` if set.
