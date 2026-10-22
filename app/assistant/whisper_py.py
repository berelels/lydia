#!/usr/bin/env python3
"""Transcribes one WAV with whisper.cpp through pywhispercpp (prebuilt wheels:
nothing is compiled on the user's computer). Same arguments and output as
whisper-cli, as voice.js uses them:

    whisper_py.py -m MODEL -f WAV -l LANG -t THREADS [--prompt TEXT]

Prints the text on stdout. Exits non-zero on failure.
"""
import argparse
import os
import sys


def read_wav(path):
    """16 kHz mono 16-bit WAV (what Lydia records) -> float32 samples, without ffmpeg."""
    import wave

    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit("16-bit WAV expected")
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if w.getnchannels() > 1:
            pcm = pcm.reshape(-1, w.getnchannels()).mean(axis=1)
        rate = w.getframerate()
    audio = pcm.astype(np.float32) / 32768.0
    if rate != 16000:  # simple linear resampling; Lydia records at 16 kHz anyway
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-m", dest="model", required=True)
    ap.add_argument("-f", dest="file", required=True)
    ap.add_argument("-l", dest="lang", default="auto")
    ap.add_argument("-t", dest="threads", type=int, default=4)
    ap.add_argument("--prompt", default="")
    a = ap.parse_args()

    # whisper.cpp's own logging goes to stderr; only the text goes to stdout
    from pywhispercpp.model import Model

    model = Model(a.model, redirect_whispercpp_logs_to=os.devnull, n_threads=a.threads, print_progress=False, print_realtime=False)
    params = {"language": a.lang, "no_timestamps": True}
    if a.prompt:
        params["initial_prompt"] = a.prompt
    segments = model.transcribe(read_wav(a.file), **params)
    sys.stdout.write(" ".join(s.text.strip() for s in segments).strip() + "\n")


if __name__ == "__main__":
    main()
