#!/usr/bin/env python3
"""Long-running Kokoro text-to-speech worker for the Hermes Alexa skill.

Usage: tts_worker.py MODEL.onnx VOICES.bin OUT_DIR
Reads one JSON request per line on stdin:  {"id": 1, "text": "...", "voice": "bf_emma", "lang": "en-gb", "speed": 1.0}
Writes one JSON reply per line on stdout:  {"id": 1, "file": "/out/1.wav"}  or  {"id": 1, "error": "..."}
The first line it prints is {"ready": true}, once the model is loaded.
"""
import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro


def main():
    model, voices, out_dir = sys.argv[1:4]
    os.makedirs(out_dir, exist_ok=True)
    kokoro = Kokoro(model, voices)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            samples, rate = kokoro.create(
                req["text"],
                voice=req.get("voice", "bf_emma"),
                speed=float(req.get("speed", 1.0)),
                lang=req.get("lang", "en-gb"),
            )
            path = os.path.join(out_dir, "%s.wav" % req_id)
            sf.write(path, samples, rate)
            print(json.dumps({"id": req_id, "file": path}), flush=True)
        except Exception as exc:  # keep the worker alive for the next request
            print(json.dumps({"id": req_id, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
