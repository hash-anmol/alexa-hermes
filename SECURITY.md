# Security

## What this runs and who can reach it

The skill server listens on `127.0.0.1` only. You expose it to Alexa through a tunnel or reverse proxy of your choice, so the public URL is reachable by anyone on the internet. These layers decide who is actually served:

1. **Amazon's signature.** Every request to `/alexa` must carry Amazon's signature headers and a fresh timestamp; the signing certificate is validated with [`alexa-verifier`](https://www.npmjs.com/package/alexa-verifier). Unsigned requests get HTTP 400.
2. **Your skill id.** Alexa signs requests from *every* skill, so the signature alone proves little. The request must also name `skill.applicationId` (or a skill listed in `skill.profiles`). With no id configured, everything is refused (HTTP 403).
3. **Secret audio paths.** Spoken answers and the alarm are served at `/voice/<secret>/…` and `/audio/<secret>/…`. The secret is random (kept in `data/skill-audio-token`, mode 600) or set with `skill.audioToken`. Only Alexa receives these URLs.

`/health` answers `ok` to anyone and reveals nothing else.

## What Hermes can do through this

Anything you can ask Hermes to do, it will do: it has terminal access on its machine. Treat the Echo like a keyboard on that machine.

- Keep **YOLO off** (the default) if you want Hermes to ask before running commands. Note that a voice session cannot answer an approval prompt, so a command that needs approval will time out or be refused. Turning YOLO on lets Hermes run commands unattended; do that only on a machine and account where you accept that.
- Anyone who can speak to your Echo, or who uses your Amazon account, can use the skill. This skill does not check which voice is speaking.
- **Gateway mode:** the Hermes API server grants the same power over HTTP. Always set a long random `API_SERVER_KEY`; prefer a private network (VPN, Tailscale) to the open internet; the key is stored in `config.json` (mode 600) or the `HERMES_API_KEY` environment variable.
- **ssh mode:** use a dedicated key for this bridge, and restrict it if you can (a forced command or a limited user).

## Secrets

Never commit `config.json`, `data/`, `build/` or any audio file. They are in `.gitignore`. If a key leaks, rotate `API_SERVER_KEY` on the Hermes machine and update `config.json`.

## Reporting a problem

Open a GitHub issue for ordinary bugs. For a security problem, please use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability") rather than a public issue.
