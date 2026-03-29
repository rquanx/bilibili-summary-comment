---
name: videocaptioner
description: Process video and audio with the VideoCaptioner CLI to transcribe speech, optimize subtitles, translate subtitles, download source media, or synthesize subtitle tracks into videos. Use when the user asks to transcribe, caption, subtitle, burn subtitles into, or translate a video or audio file, or when they want to run an end-to-end captioning pipeline.
---

# VideoCaptioner

Use the `videocaptioner` CLI directly.

## Workflow

1. Verify the input path or URL before running a processing command.
2. Infer the smallest command that satisfies the request:
   - `transcribe` for speech to subtitle/text output
   - `subtitle` for subtitle optimization or translation
   - `synthesize` for muxing or burning subtitles into a video
   - `process` for the full pipeline
   - `download` for remote video URLs
3. Prefer explicit output paths when the user cares about where results land.
4. Add `-v` when diagnosing failures or unclear behavior.
5. Add `-q` only when another command needs a clean file-path output.

## Command Patterns

### Transcribe

```bash
videocaptioner transcribe <file> [--asr ENGINE] [--language CODE] [-o PATH] [--format srt|ass|txt|json]
```

Use for speech-to-text or subtitle generation.

Defaults and helpful choices:
- Default ASR is `faster-whisper`.
- Suggest `--asr bijian` when the user wants a free option without local GPU or API setup.
- Use `--language auto` unless the source language is known and specifying it may improve accuracy.
- Default format is `srt`.

Examples:

```bash
videocaptioner transcribe video.mp4 --asr bijian
videocaptioner transcribe audio.m4a --language en --format txt -o transcript.txt
```

### Subtitle

```bash
videocaptioner subtitle <file.srt> [--translator SERVICE] [--target-language CODE] [--no-optimize] [--no-translate] [--reflect] [--prompt TEXT] [--layout LAYOUT]
```

Use for cleaning up existing subtitles, translating them, or producing bilingual layouts.

Defaults and helpful choices:
- Default translator is `llm`.
- Suggest `--translator bing` when no API key is configured and the user wants a free translation path.
- Use `--no-optimize` when the user wants a literal translation or only format conversion.
- Use `--no-translate` when the user only wants optimization.
- Use `--layout target-above`, `source-above`, `target-only`, or `source-only` to control bilingual output.
- Use `--reflect` only when the user explicitly prefers slower but more accurate translation.

Examples:

```bash
videocaptioner subtitle input.srt --translator bing --target-language en
videocaptioner subtitle zh.srt --translator llm --target-language ja --layout target-above
```

### Synthesize

```bash
videocaptioner synthesize <video> -s <subtitle> [--subtitle-mode soft|hard] [--quality ultra|high|medium|low]
```

Use for attaching subtitles to a video.

Defaults and helpful choices:
- Default subtitle mode is `soft`.
- Use `--subtitle-mode hard` when the user wants burned-in captions.
- Default quality is `medium`.

Example:

```bash
videocaptioner synthesize video.mp4 -s subtitles.srt --subtitle-mode hard --quality high
```

### Full Pipeline

```bash
videocaptioner process <file> [options]
```

Use when the user wants transcription, translation, and final subtitle synthesis in one run. Pass through the same options used by the subcommands where relevant.

Example:

```bash
videocaptioner process video.mp4 --target-language ja
```

### Download

```bash
videocaptioner download <url> [-o DIR]
```

Use for YouTube, Bilibili, or other supported URLs before later captioning steps.

## Configuration

Inspect configuration when API-backed features fail:

```bash
videocaptioner config show
videocaptioner config path
```

Common setup for LLM-backed subtitle optimization or translation:

```bash
videocaptioner config set llm.api_key <your-key>
videocaptioner config set llm.api_base https://api.openai.com/v1
videocaptioner config set llm.model gpt-4o-mini
```

Config priority is: CLI args > environment variables (`VIDEOCAPTIONER_*`) > config file > defaults.

## Troubleshooting

- Exit code `2` usually means usage or configuration is wrong.
- Exit code `3` means the input file was not found.
- Exit code `4` means a required dependency such as FFmpeg or `yt-dlp` is missing.
- Exit code `5` means runtime processing failed.
- If the user has no API key configured, recommend `--asr bijian` and `--translator bing` as free alternatives.
