param(
  [string]$VenvPath = ".3.11",
  [string]$PreferredPython = "3.11",
  [switch]$SkipNode,
  [switch]$SkipPython
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Require-Command {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Missing required command: $Name"
  }
  return $command.Source
}

function Resolve-PythonCommand {
  param([string]$PreferredVersion)

  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    try {
      & py "-$PreferredVersion" --version | Out-Null
      return @("py", "-$PreferredVersion")
    } catch {
    }
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    return @($python.Source)
  }

  throw "Python is required but was not found."
}

function Invoke-CommandArray {
  param(
    [string[]]$Command,
    [string[]]$Arguments
  )

  if ($Command.Length -le 1) {
    & $Command[0] @Arguments
    return
  }

  $extra = @()
  if ($Command.Length -gt 1) {
    $extra = $Command[1..($Command.Length - 1)]
  }

  & $Command[0] @extra @Arguments
}

if (-not $SkipNode) {
  Write-Step "Installing Node.js dependencies"
  Require-Command "node" | Out-Null
  Require-Command "npm" | Out-Null

  if (Test-Path "package-lock.json") {
    npm ci
  } else {
    npm install
  }
}

if (-not $SkipPython) {
  Write-Step "Preparing Python virtual environment"
  $pythonCommand = Resolve-PythonCommand -PreferredVersion $PreferredPython

  if (-not (Test-Path $VenvPath)) {
    Invoke-CommandArray -Command $pythonCommand -Arguments @("-m", "venv", $VenvPath)
  }

  $venvPython = Join-Path $RepoRoot "$VenvPath\Scripts\python.exe"
  if (-not (Test-Path $venvPython)) {
    throw "Virtual environment python not found: $venvPython"
  }

  & $venvPython -m pip install --upgrade pip
  & $venvPython -m pip install -r requirements.txt

  Write-Step "Checking Python tools"
  & $venvPython -m yt_dlp --version
  & $venvPython -m videocaptioner --help | Out-Null
}

$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  Write-Host ""
  Write-Warning "ffmpeg was not found in PATH. Subtitle transcription may fail until ffmpeg is installed."
}

Write-Host ""
Write-Host "Environment setup completed." -ForegroundColor Green
