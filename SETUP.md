# Setup

This project uses Node.js for Bilibili API orchestration and a Python virtual environment for subtitle tools.

## Prerequisites

- Node.js and npm
- Python 3.11 or newer
- ffmpeg in `PATH`

## Windows

```powershell
npm run setup:ps
```

Optional flags:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup/setup-env.ps1 -VenvPath .3.11 -PreferredPython 3.11
```

## macOS / Linux

```bash
bash ./scripts/setup/setup-env.sh
```

Optional environment variables:

```bash
VENV_PATH=.3.11 PREFERRED_PYTHON=python3.11 bash ./scripts/setup/setup-env.sh
```

## What the scripts do

- Install Node.js dependencies from `package-lock.json`
- Create the Python virtual environment if it does not exist
- Install `videocaptioner` and `yt-dlp` from `requirements.txt`
- Verify the Python tools are available
- Warn if `ffmpeg` is missing

## Pipeline helpers

- `npm run pipeline -- --cookie-file ./cookie.txt --bvid <BV号>` runs metadata sync, subtitle acquisition, summary generation, and optional publish with `--publish`
- `npm run sync:video -- --cookie-file ./cookie.txt --bvid <BV号>` syncs video and page metadata into SQLite
- `npm run import:summary -- --cookie-file ./cookie.txt --bvid <BV号> --summary-file work/<BV号>/summary.md` imports `<1P>` style summaries into SQLite
- `npm run publish:pending -- --cookie-file ./cookie.txt --bvid <BV号>` publishes pending page summaries into one comment thread

## Summary API environment variables

The CLI scripts automatically load environment variables from the repo root `.env` file when it exists.

- `SUMMARY_API_KEY` or `OPENAI_API_KEY`
- `SUMMARY_API_BASE_URL` or `OPENAI_BASE_URL`
- `SUMMARY_MODEL` or `OPENAI_MODEL`
- `SUMMARY_API_FORMAT` or `OPENAI_API_FORMAT`

Supported API formats:

- `auto` for automatic detection when the base URL already points at `/responses`, `/chat/completions`, or `/messages`
- `responses` for OpenAI Responses API style providers
- `openai-chat` for OpenAI-compatible `chat/completions` providers such as OpenCode Go
- `anthropic-messages` for Anthropic-compatible `messages` providers

Example for OpenCode Go:

```dotenv
SUMMARY_API_KEY=your_opencode_go_key
SUMMARY_API_BASE_URL=https://opencode.ai/zen/go/v1
SUMMARY_API_FORMAT=openai-chat
SUMMARY_MODEL=glm-5
```

## Note about SQLite

This project currently uses Node.js built-in `node:sqlite`. On Node 24 it works, but it may still print an experimental warning.
