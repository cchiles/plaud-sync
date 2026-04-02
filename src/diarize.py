#!/usr/bin/env python3
"""Standalone speaker diarization using pyannote.audio.
Outputs JSON array of {start, end, speaker} to stdout.
"""
import sys
import json
from pyannote.audio import Pipeline

def main():
    audio_path = sys.argv[1]
    hf_token = sys.argv[2]

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=hf_token,
    )

    diarization = pipeline(audio_path)

    segments = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        segments.append({
            "start": round(turn.start, 3),
            "end": round(turn.end, 3),
            "speaker": speaker,
        })

    json.dump(segments, sys.stdout)

if __name__ == "__main__":
    main()
