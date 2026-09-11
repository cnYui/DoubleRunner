#!/usr/bin/env python3
"""Generate the metronome tick sounds under agent/assets/.

Two short, percussive sine bursts (16-bit mono PCM WAV, 22.05 kHz):
  tick.wav         1200 Hz, 35 ms  - every beat
  tick-accent.wav  1800 Hz, 45 ms  - every fourth beat
Deterministic: running it twice produces identical bytes.
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

RATE = 22050
ASSETS = Path(__file__).resolve().parents[1] / "agent" / "assets"


def burst(frequency: float, duration_ms: float, peak: float = 0.8) -> bytes:
    frames = int(RATE * duration_ms / 1000)
    attack = max(1, int(RATE * 0.002))
    samples = []
    for index in range(frames):
        t = index / RATE
        envelope = math.exp(-t * 90.0)
        if index < attack:
            envelope *= index / attack
        value = peak * envelope * math.sin(2 * math.pi * frequency * t)
        samples.append(struct.pack("<h", int(max(-1.0, min(1.0, value)) * 32767)))
    return b"".join(samples)


def write(path: Path, data: bytes) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(data)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    write(ASSETS / "tick.wav", burst(1200.0, 35.0))
    write(ASSETS / "tick-accent.wav", burst(1800.0, 45.0, 0.9))
    for name in ("tick.wav", "tick-accent.wav"):
        print(name, (ASSETS / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()
