#!/usr/bin/env python3
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Local ASR helper for web-bridge media pipeline")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--language", default=None)
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad-filter", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("audio")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed. Run: python3 -m pip install faster-whisper", file=sys.stderr)
        return 2

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments_iter, info = model.transcribe(
        args.audio,
        language=args.language,
        initial_prompt=args.prompt,
        beam_size=args.beam_size,
        vad_filter=args.vad_filter,
        word_timestamps=False,
    )

    segments = []
    text_parts = []
    for index, segment in enumerate(segments_iter):
        text = segment.text.strip()
        if not text:
            continue
        segments.append({
            "id": index,
            "start": float(segment.start),
            "end": float(segment.end),
            "text": text,
        })
        text_parts.append(text)

    result = {
        "text": " ".join(text_parts),
        "language": getattr(info, "language", args.language),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
        "segments": segments,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
