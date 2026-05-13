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
# Generate latest.json (auto-updater manifest)
#
# Tauri 2's bundler emits the signed installer + .sig file, but NOT the
# `latest.json` manifest the updater fetches from the GitHub Releases
# endpoint baked into tauri.conf.json. We assemble it here so a release
# is "upload everything in $bundleDir + bundle/{nsis,msi}" with no
# out-of-band manifest authoring.
#
# Notes source priority (best → worst):
#   1. The annotated body of the `v<version>` git tag — preferred,
#      because it's intentional release prose. RECOMMENDED WORKFLOW:
#      tag the release BEFORE invoking this script.
#   2. The commit subjects between the previous tag and HEAD — accurate
#      but noisy. Used when no annotated tag exists for this version.
#   3. A stub pointing at the GitHub release page — used when there's
#      neither a tag nor a prior tag to compute a delta against.
#
# The first paragraph (up to the first blank line) of the tag body is
# what ends up in `notes`; the full body stays on the GitHub release
# page. This keeps the in-app updater dialog readable while preserving
# the structured changelog for users who click through.
# ---------------------------------------------------------------------------

function Get-ReleaseNotes {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    $tag = "v$Version"

    # 1. Annotated tag body.
    $tagBody = & git -C $RepoRoot for-each-ref "refs/tags/$tag" --format='%(contents:body)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $tagBody) {
        $body = ($tagBody | Out-String).Trim()
        # First paragraph — split on the first blank line.
        $firstPara = ($body -split "(?:\r?\n){2,}", 2)[0].Trim()
        # Strip any leading "Aura vX.Y.Z — " duplicate; the manifest
        # stamps the version separately so leaving it in is redundant.
        $firstPara = $firstPara -replace "^Aura\s+v?$([regex]::Escape($Version))\s*[—–\-]\s*", ""
        # Drop trailing Co-Authored-By trailers — these are git
        # bookkeeping, not release notes.
        $firstPara = ($firstPara -split "\r?\nCo-Authored-By:", 2)[0].TrimEnd()
        # Cap so the in-app updater dialog stays readable.
        if ($firstPara.Length -gt 600) {
            $firstPara = $firstPara.Substring(0, 597) + "..."
        }
        if ($firstPara.Length -ge 30) {
            Write-Host "[release] notes: using v$Version annotated tag body (first paragraph, $($firstPara.Length) chars)" -ForegroundColor DarkGray
            return $firstPara
        }
    }

    # 2. Commit-subject aggregation since the previous tag.
    $prevTag = & git -C $RepoRoot describe --tags --abbrev=0 --exclude=$tag HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $prevTag) {
        $log = & git -C $RepoRoot log "$prevTag..HEAD" --pretty="- %s" --no-merges 2>$null
        if ($log) {
            $joined = (($log | Out-String) -split "\r?\n" | Where-Object { $_.Trim() } | Out-String).Trim()
            if ($joined.Length -gt 560) {
                $joined = $joined.Substring(0, 557) + "..."
            }
            Write-Host "[release] notes: no v$Version tag — falling back to commit log since $prevTag" -ForegroundColor Yellow
            return "Changes since ${prevTag}:`n$joined"
        }
    }

    # 3. Stub.
    Write-Host "[release] notes: no tag history — emitting stub link" -ForegroundColor Yellow
    return "Aura $Version - see https://github.com/rm-sage/Aura/releases/tag/$tag for the full changelog."
}

$nsisInstaller = "Aura_$($pkg.version)_x64-setup.exe"
$nsisSigPath   = Join-Path $bundleDir "nsis/$nsisInstaller.sig"

if (-not (Test-Path $nsisSigPath)) {
    Write-Host "[release] WARNING: NSIS .sig file not found at $nsisSigPath — skipping latest.json generation" -ForegroundColor Yellow
    Write-Host "[release] (the bundler skipped signing — verify tauri.conf.json `plugins.updater.active` and the signing env wiring)" -ForegroundColor DarkGray
} else {
    $notes     = Get-ReleaseNotes -Version $pkg.version -RepoRoot $repoRoot
    $signature = (Get-Content -Raw -Path $nsisSigPath).Trim()
    $pubDate   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $manifest  = [ordered]@{
        version   = $pkg.version
        notes     = $notes
        pub_date  = $pubDate
        platforms = [ordered]@{
            "windows-x86_64" = [ordered]@{
                signature = $signature
                url       = "https://github.com/rm-sage/Aura/releases/download/v$($pkg.version)/$nsisInstaller"
            }
        }
    }
    $manifestPath = Join-Path $bundleDir "latest.json"
    # ConvertTo-Json escapes non-ASCII to \uXXXX by default, which keeps
    # the manifest pure-ASCII for endpoints that proxy it through
    # ASCII-only transports. The Tauri updater handles both forms fine.
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8
    Write-Host "[release] latest.json written to $manifestPath" -ForegroundColor Green
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
Write-Host "  1. If you haven't yet, tag the release with annotated notes BEFORE"
Write-Host "     re-running this script — the tag body's first paragraph is what"
Write-Host "     populates `latest.json`'s `notes` field:"
Write-Host "       git tag -a v$($pkg.version) -m '<release summary>'"
Write-Host "       git push origin v$($pkg.version)"
Write-Host "  2. Create a GitHub release for that tag (or `gh release create v$($pkg.version) --notes-from-tag`)."
Write-Host "  3. Upload installers + sig files + latest.json. Example:"
Write-Host "       gh release upload v$($pkg.version) ``"
Write-Host "         $bundleDir/nsis/Aura_$($pkg.version)_x64-setup.exe ``"
Write-Host "         $bundleDir/nsis/Aura_$($pkg.version)_x64-setup.exe.sig ``"
Write-Host "         $bundleDir/msi/Aura_$($pkg.version)_x64_en-US.msi ``"
Write-Host "         $bundleDir/msi/Aura_$($pkg.version)_x64_en-US.msi.sig ``"
Write-Host "         $bundleDir/latest.json"
Write-Host "  4. The in-app updater resolves to:"
Write-Host "       https://github.com/rm-sage/Aura/releases/latest/download/latest.json"
Write-Host "     and installs subsequent updates automatically."
Write-Host ""
