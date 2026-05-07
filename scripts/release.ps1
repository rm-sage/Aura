#Requires -Version 7.0
<#
.SYNOPSIS
    Automated signed release build for Aura.
.DESCRIPTION
    Wraps `pnpm tauri build` with the auto-updater signing keys loaded from
    the local aura-updater.key file. Produces a signed installer + a
    latest.json manifest sidecar that the in-app updater consumes.

    The private key file is git-ignored. The matching pubkey is baked into
    src-tauri/tauri.conf.json under plugins.updater.pubkey, so the running
    app verifies every update bundle against it before installing.

.PARAMETER Password
    Password for the aura-updater.key minisign key. Required unless the
    AURA_UPDATER_KEY_PASSWORD environment variable is set.

.PARAMETER KeyPath
    Path to the minisign private key. Defaults to ./aura-updater.key in
    the repo root. Override only if you keep the key elsewhere.

.PARAMETER SkipBuild
    If set, only validates the env wiring without invoking pnpm tauri build.
    Useful for verifying the key path / password before a release.

.EXAMPLE
    pwsh ./scripts/release.ps1 -Password "<key-password>"

.EXAMPLE
    $env:AURA_UPDATER_KEY_PASSWORD = "<key-password>"
    pwsh ./scripts/release.ps1
#>

param(
    [string]$Password,
    [string]$KeyPath = (Join-Path $PSScriptRoot ".." "aura-updater.key" | Resolve-Path -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path),
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

if (-not $KeyPath) {
    $KeyPath = Join-Path $repoRoot "aura-updater.key"
}

if (-not (Test-Path -Path $KeyPath -PathType Leaf)) {
    Write-Host ""
    Write-Host "ERROR: signing key not found at $KeyPath" -ForegroundColor Red
    Write-Host ""
    Write-Host "First-time setup:"
    Write-Host "  1. pnpm tauri signer generate -- -w aura-updater.key"
    Write-Host "  2. Copy the printed pubkey into src-tauri/tauri.conf.json"
    Write-Host "     under plugins.updater.pubkey."
    Write-Host "  3. Re-run this script with -Password <password>."
    Write-Host ""
    exit 1
}

if (-not $Password) {
    if ($env:AURA_UPDATER_KEY_PASSWORD) {
        $Password = $env:AURA_UPDATER_KEY_PASSWORD
    } else {
        Write-Host ""
        Write-Host "ERROR: -Password not provided and AURA_UPDATER_KEY_PASSWORD not set." -ForegroundColor Red
        Write-Host ""
        Write-Host "Either pass -Password '<key-password>' or export"
        Write-Host "AURA_UPDATER_KEY_PASSWORD before re-running."
        Write-Host ""
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Version sanity — make sure package.json + tauri.conf.json agree
# ---------------------------------------------------------------------------

$pkg = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
$conf = Get-Content (Join-Path $repoRoot "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json

if ($pkg.version -ne $conf.version) {
    Write-Host ""
    Write-Host "ERROR: version mismatch" -ForegroundColor Red
    Write-Host "  package.json:           $($pkg.version)"
    Write-Host "  src-tauri/tauri.conf:   $($conf.version)"
    Write-Host ""
    Write-Host "Bump both to the same release tag before building."
    Write-Host "The auto-updater compares the running app's version to the"
    Write-Host "latest.json manifest; mismatched versions break update detection."
    Write-Host ""
    exit 1
}

Write-Host "[release] building Aura $($pkg.version) (signed)" -ForegroundColor Cyan
Write-Host "[release] private key: $KeyPath"
Write-Host "[release] pubkey hash: $((Get-FileHash (Join-Path $repoRoot "aura-updater.key.pub") -Algorithm SHA256).Hash.Substring(0, 16))..."

# ---------------------------------------------------------------------------
# Wire env vars (key contents + password)
# ---------------------------------------------------------------------------

# Tauri's signer reads the PRIVATE KEY CONTENTS (not the path) from
# TAURI_SIGNING_PRIVATE_KEY. Pass the file body verbatim, including the
# untrusted-comment header that minisign emits.
$keyBody = Get-Content -Raw -Path $KeyPath
$env:TAURI_SIGNING_PRIVATE_KEY = $keyBody
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $Password

if ($SkipBuild) {
    Write-Host "[release] -SkipBuild set — env wiring validated, exiting." -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

Write-Host "[release] running pnpm tauri build..." -ForegroundColor Cyan

# Use the same staged-bridge path as bundle:release so the bridge sidecar
# is copied into place before tauri-build sees it.
& pnpm bundle:release
$buildExit = $LASTEXITCODE

# Clear the secrets ASAP regardless of build outcome.
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue

if ($buildExit -ne 0) {
    Write-Host ""
    Write-Host "ERROR: build failed (exit $buildExit)" -ForegroundColor Red
    exit $buildExit
}

# ---------------------------------------------------------------------------
# Locate output artifacts
# ---------------------------------------------------------------------------

$bundleDir = Join-Path $repoRoot "src-tauri/target/release/bundle"
if (-not (Test-Path $bundleDir)) {
    Write-Host "[release] WARNING: bundle dir not found at $bundleDir" -ForegroundColor Yellow
    exit 0
}

# ---------------------------------------------------------------------------
# Sentry debug-info upload
#
# Reads SENTRY_* vars from .env.local (the same file vite.config.ts reads
# at build time for source-map upload). Skips silently when any var is
# missing — useful for local builds that don't need symbolication.
# Uploads:
#   • aura.pdb        — Windows debug symbols, used to symbolicate the
#                       Rust frames inside minidumps captured by
#                       sentry-rust-minidump
# Source maps are uploaded automatically by @sentry/vite-plugin during
# the vite build step, so we don't re-upload them here.
# ---------------------------------------------------------------------------

$envLocal = Join-Path $repoRoot ".env.local"
$sentryEnv = @{}
if (Test-Path $envLocal) {
    foreach ($line in Get-Content $envLocal) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') {
            $sentryEnv[$matches[1]] = $matches[2].Trim('"').Trim()
        }
    }
}

$sentryAuth    = $sentryEnv["SENTRY_AUTH_TOKEN"]
$sentryOrg     = $sentryEnv["SENTRY_ORG"]
$sentryProject = $sentryEnv["SENTRY_PROJECT"]
$sentryUrl     = if ($sentryEnv["SENTRY_URL"]) { $sentryEnv["SENTRY_URL"] } else { "https://sentry.io/" }

$pdbPath = Join-Path $repoRoot "src-tauri/target/release/aura.pdb"

if ($sentryAuth -and $sentryOrg -and $sentryProject -and (Test-Path $pdbPath)) {
    Write-Host "[release] uploading aura.pdb to Sentry ($sentryOrg/$sentryProject)..." -ForegroundColor Cyan
    # @sentry/cli ships its binary under node_modules; pnpm exec resolves
    # the right path on Windows / macOS / Linux without us hardcoding
    # `.cmd` / `.exe` suffixes.
    $env:SENTRY_AUTH_TOKEN = $sentryAuth
    $env:SENTRY_ORG        = $sentryOrg
    $env:SENTRY_PROJECT    = $sentryProject
    $env:SENTRY_URL        = $sentryUrl
    & pnpm exec sentry-cli debug-files upload --include-sources $pdbPath
    $uploadExit = $LASTEXITCODE
    Remove-Item Env:SENTRY_AUTH_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:SENTRY_ORG -ErrorAction SilentlyContinue
    Remove-Item Env:SENTRY_PROJECT -ErrorAction SilentlyContinue
    Remove-Item Env:SENTRY_URL -ErrorAction SilentlyContinue
    if ($uploadExit -ne 0) {
        Write-Host "[release] WARNING: PDB upload failed (exit $uploadExit) — continuing anyway." -ForegroundColor Yellow
    } else {
        Write-Host "[release] PDB upload OK." -ForegroundColor Green
    }
} elseif (-not (Test-Path $pdbPath)) {
    Write-Host "[release] no aura.pdb at $pdbPath — Cargo release profile may be stripping debug info" -ForegroundColor Yellow
} else {
    Write-Host "[release] Sentry env vars not set in .env.local — skipping PDB upload." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[release] BUILD SUCCEEDED" -ForegroundColor Green
Write-Host "[release] release artifacts under: $bundleDir"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Tag the release (e.g. git tag v$($pkg.version) && git push --tags)"
Write-Host "  2. Create a GitHub release for that tag"
Write-Host "  3. Upload BOTH:"
Write-Host "       • the .msi (or .exe) installer from $bundleDir/msi/ (or /nsis/)"
Write-Host "       • the latest.json manifest (alongside the installer)"
Write-Host "  4. The in-app updater resolves to:"
Write-Host "       https://github.com/rm-sage/Aura/releases/latest/download/latest.json"
Write-Host "     and installs subsequent updates automatically."
Write-Host ""
