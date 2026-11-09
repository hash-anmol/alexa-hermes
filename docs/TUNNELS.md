# A public HTTPS address for Alexa

Alexa calls your skill from Amazon's servers, so the skill server (`127.0.0.1:8787`) needs an **https://** address on the internet with a certificate from a normal authority. Any tunnel or reverse proxy that forwards to that port works. Put the result in `skill.publicBase` (no trailing slash), for example `https://my-box.tail1234.ts.net`.

The server also needs to keep running: `alexa-hermes service install` (Linux) or `alexa-hermes start`.

## Tailscale Funnel (tested)

Stable address, free, one command.

```bash
tailscale funnel --bg 8787
tailscale funnel status          # shows https://<machine>.<tailnet>.ts.net
```

Funnel must be allowed for the machine in your tailnet policy and HTTPS certificates enabled in the admin console ([Tailscale Funnel docs](https://tailscale.com/kb/1223/funnel)). Endpoint to give Alexa: `https://<machine>.<tailnet>.ts.net/alexa`.

## Cloudflare Tunnel

With a domain on Cloudflare, a named tunnel gives a stable address ([docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)):

```bash
cloudflared tunnel login
cloudflared tunnel create alexa-hermes
cloudflared tunnel route dns alexa-hermes hermes.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 alexa-hermes
```

Endpoint: `https://hermes.example.com/alexa`. A quick tunnel (`cloudflared tunnel --url http://127.0.0.1:8787`) works for a trial but its address changes on every restart.

## ngrok

```bash
ngrok http 8787       # use a reserved/static domain so the address does not change
```

Endpoint: `https://<your-domain>.ngrok-free.app/alexa`.

## A server you already have

A reverse proxy (Caddy, nginx) on a machine with a public IP and a Let's Encrypt certificate, forwarding `https://hermes.example.com/` to `127.0.0.1:8787`, works too.

> Only Tailscale Funnel has been tested by the author. The others are ordinary HTTPS forwards; if one gives you trouble, `alexa-hermes doctor` and the Alexa console's *Test* tab will tell you what Alexa sees.

## Check it

```bash
curl https://<your address>/health      # prints: ok
node bin/alexa-hermes.js doctor
```
