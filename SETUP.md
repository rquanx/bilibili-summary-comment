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
powershell -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -VenvPath .3.11 -PreferredPython 3.11
```

## macOS / Linux

```bash
bash ./scripts/setup-env.sh
```

Optional environment variables:

```bash
VENV_PATH=.3.11 PREFERRED_PYTHON=python3.11 bash ./scripts/setup-env.sh
```

## What the scripts do

- Install Node.js dependencies from `package-lock.json`
- Create the Python virtual environment if it does not exist
- Install `videocaptioner` and `yt-dlp` from `requirements.txt`
- Verify the Python tools are available
- Warn if `ffmpeg` is missing
