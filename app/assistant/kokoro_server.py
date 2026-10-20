#!/usr/bin/env python3
"""Lydia's voice: Kokoro (a small neural TTS) kept loaded, one request per line.

stdin:  {"text": "...", "lang": "pt", "id": 1}
stdout: {"id": 1, "wav": "/run/user/1000/lydia-say-1.wav"}  or  {"id": 1, "error": "..."}
Usage: kokoro_server.py <model.onnx> <voices.bin>
"""
import json
import os
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro

# Female voices, natural-sounding: Brazilian Portuguese, American English, Spanish.
VOICES = {"pt": ("pf_dora", "pt-br"), "en": ("af_heart", "en-us"), "es": ("ef_dora", "es")}
RUN = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"


def main():
    kokoro = Kokoro(sys.argv[1], sys.argv[2])
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        try:
            voice, lang = VOICES.get(req.get("lang"), VOICES["en"])
            samples, rate = kokoro.create(req["text"], voice=voice, speed=float(req.get("speed", 1.0)), lang=lang)
            path = os.path.join(RUN, f"lydia-say-{os.getpid()}-{rid}.wav")
            pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes(pcm.tobytes())
            print(json.dumps({"id": rid, "wav": path}), flush=True)
        except Exception as err:  # noqa: BLE001 - report anything back to Lydia
            print(json.dumps({"id": rid, "error": str(err)[:300]}), flush=True)


if __name__ == "__main__":
    main()
