#Requires -Version 5.1
<#
.SYNOPSIS
    Installs or updates the Claude Code status line.

.DESCRIPTION
    Copies statusline.mjs to a single shared location (by default ~/.claude) and points the
    statusLine setting of one or more Claude Code profiles at it, so that with several
    profiles there is still only one file to update.

    Only the statusLine key of settings.json is touched; every other setting, and any
    other option inside statusLine such as padding, is preserved. A timestamped backup of
    settings.json is written before any change.

.PARAMETER ConfigDir
    The Claude Code profile to configure, e.g. "$HOME\.claude-work". When omitted, every
    profile found in the home directory is offered.

.PARAMETER ScriptDir
    Where statusline.mjs is installed. Defaults to "$HOME\.claude".

.PARAMETER Force
    Overwrite an installed script even if it is newer than, or was edited after, the one
    being installed.

.PARAMETER NonInteractive
    Never prompt. With several profiles only the default one is configured, and a newer
    installed script is kept unless -Force is given.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -ConfigDir "$HOME\.claude-work" -NonInteractive

.NOTES
    This file must stay ASCII-only: Windows PowerShell 5.1 reads a .ps1 without a BOM
    in the system code page, and any accented character would be mangled.
#>
[CmdletBinding()]
param(
    [string]$ConfigDir,
    [string]$ScriptDir = (Join-Path $HOME '.claude'),
    [switch]$Force,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

# powershell -NonInteractive makes Read-Host throw instead of prompting, so it counts too
$script:Interactive = -not $NonInteractive -and [Environment]::UserInteractive -and
    -not ([Environment]::GetCommandLineArgs() | Where-Object { $_ -like '-NonI*' })

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Line([string]$Text = '', [string]$Color = 'Gray') {
    Write-Host $Text -ForegroundColor $Color
}

function Read-YesNo([string]$Prompt, [bool]$Default) {
    if (-not $script:Interactive) { return $Default }
    $hint = if ($Default) { '(Y/n)' } else { '(y/N)' }
    $answer = Read-Host "  $Prompt $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer -match '^[Yy]'
}

# Runs node with text written explicitly to its stdin. A plain pipe fails when the
# installer starts from a context with no stdin of its own, and the test run would then
# report a failure that is not there. The text must stay ASCII: Windows PowerShell 5.1
# offers no way to choose the encoding of a child's stdin.
function Invoke-Node([string]$Stdin, [string[]]$Arguments = @()) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = (Get-Command node).Source
    $psi.Arguments              = ($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $psi.UseShellExecute        = $false
    $psi.RedirectStandardInput  = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.StandardOutputEncoding = $utf8NoBom
    $psi.StandardErrorEncoding  = $utf8NoBom
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write($Stdin)
    $proc.StandardInput.Close()
    # stderr is drained in parallel: read one after the other, a full pipe deadlocks both
    $errTask = $proc.StandardError.ReadToEndAsync()
    $out = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    [pscustomobject]@{ ExitCode = $proc.ExitCode; Out = $out.Trim(); Err = $errTask.Result.Trim() }
}

# The "// version: X.Y.Z" line at the top of the script. $null when the file does not
# exist, [version]'0.0' when it predates version lines or the line cannot be parsed.
function Get-ScriptVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $match = Select-String -LiteralPath $Path -Pattern '^// version: (\d+\.\d+\.\d+)' | Select-Object -First 1
    if ($match) { return [version]$match.Matches[0].Groups[1].Value }
    return [version]'0.0'
}

Write-Line
Write-Line '  Status line for Claude Code - setup' 'Cyan'
Write-Line '  -----------------------------------' 'Cyan'
Write-Line

$source = Join-Path $PSScriptRoot 'statusline.mjs'
$target = Join-Path $ScriptDir 'statusline.mjs'

# --- prerequisites ------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $source)) {
    Write-Line '  ERROR: statusline.mjs is not next to this installer.' 'Red'
    Write-Line '  Keep all the files of the package together in one folder.' 'Red'
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Line '  ERROR: Node.js is not installed, or not on the PATH.' 'Red'
    Write-Line '  Install it from https://nodejs.org and run this installer again.' 'Red'
    exit 1
}
# The script relies on syntax and Unicode regex classes older releases do not have. Better
# to stop here than to leave an empty status line with no explanation.
$nodeVersion = (Invoke-Node 'console.log(process.versions.node)' @('-')).Out
if ([int]($nodeVersion -split '\.')[0] -lt 18) {
    Write-Line "  ERROR: Node.js $nodeVersion is too old; version 18 or later is required." 'Red'
    Write-Line '  Update it from https://nodejs.org and run this installer again.' 'Red'
    exit 1
}
Write-Line "  Node.js $nodeVersion : $((Get-Command node).Source)" 'DarkGray'

if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Line "  Git: $((Get-Command git).Source)" 'DarkGray'
} else {
    Write-Line '  Note: git is not on the PATH. Everything works, except the branch segment.' 'Yellow'
}

# --- which profiles -----------------------------------------------------------------

$defaultProfile = Join-Path $HOME '.claude'
if ($ConfigDir) {
    $targets = @($ConfigDir)
} else {
    $profiles = @(
        Get-ChildItem -Path $HOME -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq '.claude' -or $_.Name -like '.claude-*' } |
            Sort-Object Name
    )
    if ($profiles.Count -le 1) {
        $targets = @($defaultProfile)
    } elseif (-not $script:Interactive) {
        $targets = @($defaultProfile)
        Write-Line "  Several profiles found; configuring only $defaultProfile (use -ConfigDir for the others)." 'Yellow'
    } else {
        Write-Line
        Write-Line '  Several Claude Code profiles found in your home folder:' 'Yellow'
        for ($i = 0; $i -lt $profiles.Count; $i++) {
            Write-Line ('    [{0}] {1}' -f ($i + 1), $profiles[$i].Name)
        }
        Write-Line '    [A] all of them' 'DarkGray'
        $choice = Read-Host '  Which one should be configured? (Enter = 1)'
        if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '1' }
        if ($choice -match '^[Aa]') {
            $targets = @($profiles | ForEach-Object { $_.FullName })
        } else {
            $n = 0
            if (-not [int]::TryParse($choice, [ref]$n) -or $n -lt 1 -or $n -gt $profiles.Count) {
                Write-Line '  Not a valid choice.' 'Red'
                exit 1
            }
            $targets = @($profiles[$n - 1].FullName)
        }
    }
}

# --- the script, in its shared location ---------------------------------------------

if (-not (Test-Path -LiteralPath $ScriptDir)) {
    New-Item -ItemType Directory -Path $ScriptDir | Out-Null
}

Write-Line
$newVersion = Get-ScriptVersion $source
$oldVersion = Get-ScriptVersion $target
if ([System.IO.Path]::GetFullPath($source) -ieq [System.IO.Path]::GetFullPath($target)) {
    # run from inside the install folder: nothing to copy
    Write-Line "  The script is already in place: $target" 'DarkGray'
} elseif ($null -ne $oldVersion -and (Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $target).Hash) {
    Write-Line "  Script already up to date (version $newVersion)" 'DarkGray'
} else {
    # Never silently replace a newer script, or one edited by hand, with the one in this
    # package: carrying an old copy of the package to another machine must be harmless.
    $copy = $true
    if (-not $Force -and $null -ne $oldVersion -and $oldVersion -gt $newVersion) {
        Write-Line "  The installed script is NEWER ($oldVersion) than this package ($newVersion)." 'Yellow'
        $copy = Read-YesNo 'Replace it with the older one?' $false
    } elseif (-not $Force -and $null -ne $oldVersion -and $oldVersion -eq $newVersion) {
        Write-Line "  The installed script has the same version ($oldVersion) but different content:" 'Yellow'
        Write-Line '  it has probably been edited by hand.' 'Yellow'
        $copy = Read-YesNo 'Replace it?' $false
    }
    if ($copy) {
        Copy-Item -LiteralPath $source -Destination $target -Force
        $from = if ($null -eq $oldVersion) { 'new install' }
                elseif ($oldVersion -eq [version]'0.0') { 'replacing an unversioned script' }
                else { "was $oldVersion" }
        Write-Line "  Installed: $target (version $newVersion, $from)" 'Green'
    } else {
        Write-Line '  Installed script left unchanged.' 'DarkGray'
    }
}

# --- the statusLine setting of each profile -----------------------------------------

# settings.json is edited by node, not by PowerShell: ConvertFrom-Json in Windows
# PowerShell 5.1 rejects keys that differ only in case (common under "env"), and
# ConvertTo-Json would reformat the whole file. node reads and writes it the way Claude
# Code itself does, and touches only statusLine.
# Result on stdout: invalid | unchanged | added|<backup> | replaced|<backup>|<previous command>
$settingsEditor = @'
const fs = require('fs');
const [file, command] = process.argv.slice(2);
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
let settings = {};
if (text.trim()) {
  try { settings = JSON.parse(text); } catch { console.log('invalid'); process.exit(0); }
}
if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) { console.log('invalid'); process.exit(0); }
const current = settings.statusLine && typeof settings.statusLine === 'object' ? settings.statusLine : null;
if (current && current.type === 'command' && current.command === command) { console.log('unchanged'); process.exit(0); }
let backup = '';
if (text) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  backup = `${file}.bak-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  fs.copyFileSync(file, backup);
}
settings.statusLine = { ...(current || {}), type: 'command', command };
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(current ? `replaced|${backup}|${current.command || ''}` : `added|${backup}`);
'@

# An absolute path with forward slashes works whichever shell Claude Code runs the command
# with: "~" is expanded by bash, but not by cmd.exe nor by every PowerShell version.
$command = 'node "' + ((Resolve-Path -LiteralPath $target).Path -replace '\\', '/') + '"'

$failures = 0
foreach ($profileDir in $targets) {
    Write-Line
    Write-Line "  Profile: $profileDir" 'Cyan'

    if (-not (Test-Path -LiteralPath $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir | Out-Null
        Write-Line '    folder created' 'DarkGray'
    }

    $result = Invoke-Node $settingsEditor @('-', (Join-Path $profileDir 'settings.json'), $command)
    if ($result.ExitCode -ne 0) {
        Write-Line "    ERROR while editing settings.json: $($result.Err)" 'Red'
        $failures++
        continue
    }
    $parts = $result.Out -split '\|'
    switch ($parts[0]) {
        'invalid' {
            Write-Line '    ERROR: settings.json is not a valid JSON object; left untouched.' 'Red'
            $failures++
        }
        'unchanged' {
            Write-Line '    already configured, left untouched' 'DarkGray'
        }
        default {
            if ($parts[0] -eq 'replaced') { Write-Line "    replaced the previous status line ($($parts[2]))" 'Yellow' }
            if ($parts[1]) { Write-Line "    backup: $(Split-Path $parts[1] -Leaf)" 'DarkGray' }
            Write-Line '    configured' 'Green'
        }
    }
}

# --- a test run with sample data ----------------------------------------------------

Write-Line
Write-Line '  Test run with sample data (111k context, half-way through the budget windows):' 'Cyan'

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
# Built with ConvertTo-Json: written by hand, Windows backslashes went unescaped and the
# payload was not valid JSON.
$payload = @{
    model          = @{ display_name = 'Opus (sample)' }
    effort         = @{ level = 'high' }
    workspace      = @{ current_dir = $HOME; project_dir = $HOME }
    context_window = @{
        used_percentage     = 11
        context_window_size = 1000000
        current_usage       = @{ input_tokens = 0; cache_creation_input_tokens = 0; cache_read_input_tokens = 111000 }
    }
    rate_limits    = @{
        five_hour = @{ used_percentage = 20; resets_at = $now + 150 * 60 }
        seven_day = @{ used_percentage = 25; resets_at = $now + 84 * 3600 }
    }
} | ConvertTo-Json -Depth 10 -Compress
# stdin must stay ASCII (see Invoke-Node): an accented home folder becomes a \uXXXX
# escape, which JSON reads back as the same character
$payload = [regex]::Replace($payload, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })

$sample = Invoke-Node $payload @($target)
if ([string]::IsNullOrWhiteSpace($sample.Out)) {
    Write-Line '  The test run printed nothing. Check the Node.js installation.' 'Red'
    if ($sample.Err) { Write-Line "  $($sample.Err)" 'Red' }
    exit 1
}
Write-Line "  $($sample.Out)"
Write-Line

if ($failures -gt 0) {
    Write-Line "  Done, but $failures profile(s) could not be configured - see above." 'Yellow'
    Write-Line
    exit 2
}
Write-Line '  Done. Restart Claude Code to see it.' 'Green'
Write-Line
# explicit, so that a caller using & sees 0 rather than whatever $LASTEXITCODE held before
exit 0
