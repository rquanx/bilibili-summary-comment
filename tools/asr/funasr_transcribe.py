from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable


DEFAULT_MODEL = "paraformer-zh"
DEFAULT_VAD_MODEL = "fsmn-vad"
DEFAULT_PUNC_MODEL = "ct-punc"
DEFAULT_BATCH_SIZE_S = 300
DEFAULT_MAX_LINE_LENGTH = 30
DEFAULT_MAX_CUE_DURATION_MS = 12_000


def main() -> int:
    args = parse_args()

    try:
        from funasr import AutoModel
    except ImportError as exc:
        raise SystemExit(
            "FunASR is not installed. Run `python -m pip install -r requirements.txt` "
            "or install `funasr` in the configured venv."
        ) from exc

    model_kwargs: dict[str, Any] = {
        "model": args.model,
        "vad_model": args.vad_model or None,
        "device": resolve_device(args.device),
    }
    if args.punc_model:
        model_kwargs["punc_model"] = args.punc_model
    if args.disable_update:
        model_kwargs["disable_update"] = True

    model_kwargs = {key: value for key, value in model_kwargs.items() if value not in ("", None)}
    model = AutoModel(**model_kwargs)

    generate_kwargs: dict[str, Any] = {
        "input": args.audio,
        "batch_size_s": args.batch_size_s,
        "merge_vad": True,
        "merge_length_s": args.merge_length_s,
        "output_timestamp": True,
        "return_time_stamps": True,
        "sentence_timestamp": True,
        "return_raw_text": True,
    }
    if args.language:
        generate_kwargs["language"] = args.language
    if args.hotword:
        generate_kwargs["hotword"] = args.hotword

    result = model.generate(**generate_kwargs)
    if args.metadata_output:
        Path(args.metadata_output).write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    cues = build_cues(result, audio_path=args.audio, max_line_length=args.max_line_length)
    if not cues:
        raise SystemExit(f"FunASR did not return usable timestamped text for {args.audio}")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(format_srt(cues), encoding="utf-8")

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with FunASR and write SRT.")
    parser.add_argument("audio", help="Input audio path.")
    parser.add_argument("-o", "--output", required=True, help="Output SRT path.")
    parser.add_argument("--model", default=os.environ.get("FUNASR_MODEL", DEFAULT_MODEL))
    parser.add_argument("--vad-model", default=os.environ.get("FUNASR_VAD_MODEL", DEFAULT_VAD_MODEL))
    parser.add_argument("--punc-model", default=os.environ.get("FUNASR_PUNC_MODEL", DEFAULT_PUNC_MODEL))
    parser.add_argument("--device", default=os.environ.get("FUNASR_DEVICE", "auto"))
    parser.add_argument("--language", default=os.environ.get("FUNASR_LANGUAGE", "zh"))
    parser.add_argument("--hotword", default=os.environ.get("FUNASR_HOTWORD", ""))
    parser.add_argument(
        "--batch-size-s",
        type=int,
        default=int(os.environ.get("FUNASR_BATCH_SIZE_S", DEFAULT_BATCH_SIZE_S)),
    )
    parser.add_argument(
        "--merge-length-s",
        type=int,
        default=int(os.environ.get("FUNASR_MERGE_LENGTH_S", 15)),
    )
    parser.add_argument(
        "--max-line-length",
        type=int,
        default=int(os.environ.get("FUNASR_MAX_LINE_LENGTH", DEFAULT_MAX_LINE_LENGTH)),
    )
    parser.add_argument("--metadata-output", default=os.environ.get("FUNASR_METADATA_OUTPUT", ""))
    parser.add_argument("--disable-update", action="store_true", default=os.environ.get("FUNASR_DISABLE_UPDATE") == "1")
    return parser.parse_args()


def resolve_device(configured: str) -> str:
    normalized = str(configured or "auto").strip().lower()
    if normalized != "auto":
        return configured

    try:
        import torch

        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def build_cues(result: Any, *, audio_path: str | None = None, max_line_length: int) -> list[dict[str, Any]]:
    items = result if isinstance(result, list) else [result]
    cues: list[dict[str, Any]] = []

    for item in items:
        if not isinstance(item, dict):
            continue
        sentence_cues = cues_from_sentence_info(item.get("sentence_info"), max_line_length=max_line_length)
        if sentence_cues:
            cues.extend(sentence_cues)
            continue
        timestamp_cues = cues_from_timestamp(item, max_line_length=max_line_length)
        if timestamp_cues:
            cues.extend(timestamp_cues)
            continue
        cues.extend(cues_from_plain_text(item, audio_path=audio_path, max_line_length=max_line_length))

    return normalize_cues(cues)


def cues_from_plain_text(
    item: dict[str, Any],
    *,
    audio_path: str | None,
    max_line_length: int,
) -> list[dict[str, Any]]:
    text_parts = split_text(clean_text(item.get("text")), max_line_length=max_line_length)
    duration_ms = read_audio_duration_ms(audio_path)
    if not text_parts or duration_ms <= 0:
        return []

    total_chars = sum(max(1, len(part)) for part in text_parts)
    cursor_ms = 0
    cues: list[dict[str, Any]] = []
    for text_part in text_parts:
        part_ms = max(800, round(duration_ms * max(1, len(text_part)) / total_chars))
        end_ms = min(duration_ms, cursor_ms + part_ms)
        cues.append({"start": cursor_ms, "end": end_ms, "text": text_part})
        cursor_ms = end_ms

    return cues


def cues_from_sentence_info(sentence_info: Any, *, max_line_length: int) -> list[dict[str, Any]]:
    if not isinstance(sentence_info, list):
        return []

    cues: list[dict[str, Any]] = []
    for sentence in sentence_info:
        if not isinstance(sentence, dict):
            continue

        text = clean_text(
            sentence.get("text")
            or sentence.get("sentence")
            or sentence.get("raw_text")
            or sentence.get("value")
        )
        if not text:
            continue

        start_ms = read_ms(first_present(sentence, "start", "start_time", "begin"))
        end_ms = read_ms(first_present(sentence, "end", "end_time", "timestamp"))
        if start_ms is None or end_ms is None:
            timestamp = sentence.get("timestamp")
            if isinstance(timestamp, (list, tuple)) and len(timestamp) >= 2:
                start_ms = read_ms(timestamp[0])
                end_ms = read_ms(timestamp[-1])
        if start_ms is None or end_ms is None:
            continue

        for text_part in split_text(text, max_line_length=max_line_length):
            cues.append({"start": start_ms, "end": end_ms, "text": text_part})

    return cues


def cues_from_timestamp(item: dict[str, Any], *, max_line_length: int) -> list[dict[str, Any]]:
    text = clean_text(item.get("text"))
    timestamp = item.get("timestamp")
    if not text or not isinstance(timestamp, list):
        return []

    text_parts = split_text(text, max_line_length=max_line_length)
    if not text_parts:
        return []

    char_count = max(1, len([char for char in text if not char.isspace()]))
    timestamp_count = max(1, len(timestamp))
    cursor = 0
    cues: list[dict[str, Any]] = []

    for text_part in text_parts:
        part_count = max(1, len([char for char in text_part if not char.isspace()]))
        start_index = min(timestamp_count - 1, round(cursor * timestamp_count / char_count))
        end_index = min(timestamp_count - 1, max(start_index, round((cursor + part_count) * timestamp_count / char_count) - 1))
        start_ms, _ = read_timestamp_pair(timestamp[start_index])
        _, end_ms = read_timestamp_pair(timestamp[end_index])
        if start_ms is not None and end_ms is not None:
            cues.append({"start": start_ms, "end": end_ms, "text": text_part})
        cursor += part_count

    return cues


def normalize_cues(cues: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    previous_end = 0

    for cue in sorted(cues, key=lambda item: int(item.get("start") or 0)):
        text = clean_text(cue.get("text"))
        if not text:
            continue

        start = max(0, int(cue.get("start") or previous_end))
        end = max(start + 200, int(cue.get("end") or start + 200))
        if end - start > DEFAULT_MAX_CUE_DURATION_MS:
            end = start + DEFAULT_MAX_CUE_DURATION_MS
        if start < previous_end:
            start = previous_end
            end = max(end, start + 200)

        normalized.append({"start": start, "end": end, "text": text})
        previous_end = end

    return normalized


def split_text(text: str, *, max_line_length: int) -> list[str]:
    parts: list[str] = []
    current = ""
    punctuation = "。！？!?；;，,"

    for char in text:
        current += char
        if char in punctuation or len(current) >= max_line_length:
            stripped = current.strip()
            if stripped:
                parts.append(stripped)
            current = ""

    stripped = current.strip()
    if stripped:
        parts.append(stripped)

    return parts


def clean_text(value: Any) -> str:
    text = str(value or "")
    text = html.unescape(text)
    text = re.sub(r"<\|[^|]+?\|>", "", text)
    text = re.sub(r"\[[A-Z_]+\]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def read_ms(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        if not value:
            return None
        return read_ms(value[-1])
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < 0:
        return None
    return int(number)


def first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def read_timestamp_pair(value: Any) -> tuple[int | None, int | None]:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return read_ms(value[0]), read_ms(value[1])
    timestamp = read_ms(value)
    return timestamp, timestamp


def read_audio_duration_ms(audio_path: str | None) -> int:
    if not audio_path:
        return 0
    try:
        import soundfile as sf

        return int(sf.info(audio_path).duration * 1000)
    except Exception:
        return 0


def format_srt(cues: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for index, cue in enumerate(cues, start=1):
        lines.extend([
            str(index),
            f"{format_srt_timestamp(cue['start'])} --> {format_srt_timestamp(cue['end'])}",
            str(cue["text"]),
            "",
        ])
    return "\n".join(lines)


def format_srt_timestamp(ms: int) -> str:
    hours, remainder = divmod(ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


if __name__ == "__main__":
    sys.exit(main())
