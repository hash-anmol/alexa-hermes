#!/usr/bin/env bash
# Alexa Hermes installer. Safe to run again.
#
#   ./setup.sh                      ask a few questions (local / ssh / gateway Hermes), install, check
#   ./setup.sh --voice              also install the offline Kokoro voice (spoken answers) and ffmpeg check
#   ./setup.sh --service            also install the systemd user service (Linux)
#   ./setup.sh --yes --mode gateway --url http://hermes-box:8642 --token KEY
#                                   no questions: every flag of `alexa-hermes init` is passed through
#
# Needs: Node.js 18+. For --voice: python3 with venv, ffmpeg, about 330 MB of disk for the voice model.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
VOICE=0
SERVICE=0
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --voice) VOICE=1 ;;
    --service) SERVICE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) PASS+=("$1") ;;
  esac
  shift
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

say "Checking Node.js"
command -v node >/dev/null 2>&1 || die "Node.js 18 or newer is required. Install it from https://nodejs.org or with your package manager, then run ./setup.sh again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js $NODE_MAJOR is too old; you need 18 or newer."
command -v npm >/dev/null 2>&1 || die "npm is required (it comes with Node.js)."
echo "    node $(node -v)"

say "Installing dependencies"
npm install --omit=dev --no-audit --no-fund --silent
mkdir -p audio data
chmod 700 data
[ -f audio/.gitkeep ] || : > audio/.gitkeep

if [ "$VOICE" = 1 ]; then
  say "Installing the Kokoro voice (spoken answers)"
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is required for spoken answers. Install it (apt install ffmpeg, brew install ffmpeg), then run: ./setup.sh --voice"
  command -v python3 >/dev/null 2>&1 || die "python3 is required for the Kokoro voice."
  python3 -c 'import venv' 2>/dev/null || die "python3-venv is missing. On Debian/Ubuntu: sudo apt install python3-venv"
  if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet "kokoro-onnx==0.5.0" soundfile
  MODEL_DIR="$HOME/.kokoro"
  mkdir -p "$MODEL_DIR"
  BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files"
  fetch() { # fetch URL DEST
    if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$2.part" "$1"; else wget -O "$2.part" "$1"; fi
    mv "$2.part" "$2"
  }
  [ -s "$MODEL_DIR/kokoro-v0_19.onnx" ] || { echo "    downloading kokoro-v0_19.onnx (about 325 MB)"; fetch "$BASE/kokoro-v0_19.onnx" "$MODEL_DIR/kokoro-v0_19.onnx"; }
  [ -s "$MODEL_DIR/voices.bin" ] || { echo "    downloading voices.bin"; fetch "$BASE/voices.bin" "$MODEL_DIR/voices.bin"; }
  VENV_PY="$ROOT/.venv/bin/python"
fi

say "Creating config.json"
if [ -f config.json ]; then
  echo "    config.json already exists, leaving it alone (edit it, or: node bin/alexa-hermes.js init --force)"
else
  node bin/alexa-hermes.js init ${PASS[@]+"${PASS[@]}"}
fi

if [ "$VOICE" = 1 ] && [ -f config.json ]; then
  # point the skill at the venv that has Kokoro
  VENV_PY="$VENV_PY" node -e '
    const fs = require("fs"), f = "config.json", c = JSON.parse(fs.readFileSync(f, "utf8"));
    c.skill = c.skill || {}; c.skill.speech = { ...(c.skill.speech || {}), enabled: true, python: process.env.VENV_PY };
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });'
  echo "    voice: using $VENV_PY"
fi

if [ "$SERVICE" = 1 ]; then
  say "Installing the service"
  node bin/alexa-hermes.js service install
fi

say "Checking the setup"
node bin/alexa-hermes.js doctor || true

cat <<EOT

Next steps
  1. Make the skill server reachable over HTTPS:        docs/TUNNELS.md
  2. Create the private Alexa skill and paste the model: docs/ALEXA-SKILL.md
       node bin/alexa-hermes.js model            (writes build/interaction-model.<name>.json)
  3. Put the skill id and public address in config.json, then:
       node bin/alexa-hermes.js start            (or: systemctl --user enable --now alexa-hermes)
  4. node bin/alexa-hermes.js doctor               until every line says PASS
  5. Say: "Alexa, ask Hermes what's on my plate today"
EOT
