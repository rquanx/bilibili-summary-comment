from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from faster_whisper import WhisperModel


VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"}


def format_srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def output_stem(video: Path) -> str:
    safe_name = re.sub(r'[<>:"/\\|?*]+', "_", video.stem).strip()
    return safe_name or "transcript"


def write_outputs(segments: list[tuple[float, float, str]], output_dir: Path, stem: str) -> None:
    srt_path = output_dir / f"{stem}.srt"
    txt_path = output_dir / f"{stem}.txt"

    with srt_path.open("w", encoding="utf-8", newline="\n") as srt_file:
        for index, (start, end, text) in enumerate(segments, start=1):
            srt_file.write(
                f"{index}\n"
                f"{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}\n"
                f"{text}\n\n"
            )

    with txt_path.open("w", encoding="utf-8", newline="\n") as txt_file:
        for _, _, text in segments:
            txt_file.write(f"{text}\n")


def transcribe(model: WhisperModel, video: Path, output_dir: Path) -> None:
    stem = output_stem(video)
    srt_path = output_dir / f"{stem}.srt"
    txt_path = output_dir / f"{stem}.txt"
    if srt_path.exists() and txt_path.exists():
        print(f"SKIP {video.name}")
        return

    print(f"START {video.name}", flush=True)
    segments, info = model.transcribe(
        str(video),
        language="zh",
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
        condition_on_previous_text=True,
    )
    completed_segments: list[tuple[float, float, str]] = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            completed_segments.append((segment.start, segment.end, text))

    write_outputs(completed_segments, output_dir, stem)
    print(
        f"DONE {video.name} | language={info.language} | segments={len(completed_segments)}",
        flush=True,
    )


def write_combined_text(videos: list[Path], output_dir: Path) -> None:
    combined_path = output_dir / "全部字幕汇总.txt"
    with combined_path.open("w", encoding="utf-8", newline="\n") as combined_file:
        for video in videos:
            txt_path = output_dir / f"{output_stem(video)}.txt"
            if not txt_path.exists():
                continue
            combined_file.write(f"===== {video.name} =====\n\n")
            combined_file.write(txt_path.read_text(encoding="utf-8").strip())
            combined_file.write("\n\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe all videos in a directory to SRT and TXT.")
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--model", default="deepdml/faster-whisper-large-v3-turbo-ct2")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="int8_float16")
    args = parser.parse_args()

    input_dir = args.input_dir.resolve()
    output_dir = (args.output_dir or input_dir / "subtitles").resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    videos = sorted(path for path in input_dir.rglob("*") if path.suffix.lower() in VIDEO_EXTENSIONS)
    if not videos:
        print(f"No supported videos found in {input_dir}", file=sys.stderr)
        return 1

    print(f"Loading model: {args.model} ({args.device}, {args.compute_type})", flush=True)
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    for video in videos:
        transcribe(model, video, output_dir)

    write_combined_text(videos, output_dir)
    print(f"Completed {len(videos)} video(s). Output: {output_dir}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
