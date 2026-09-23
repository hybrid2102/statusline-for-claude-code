#Requires -Modules @{ ModuleName = 'Pester'; ModuleVersion = '5.5.0' }

# These tests run the real installer in a child process of the same PowerShell edition,
# against throwaway folders: -ScriptDir and -ConfigDir keep it away from the real profile,
# and -NonInteractive makes every question take its safe default.

BeforeAll {
    $script:Installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1'
    $script:Source = Join-Path (Split-Path $PSScriptRoot -Parent) 'statusline.mjs'
    $script:Shell = (Get-Process -Id $PID).Path

    function Invoke-Installer([string]$ScriptDir, [string]$ConfigDir, [switch]$Force) {
        $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', $script:Installer,
            '-ScriptDir', $ScriptDir, '-ConfigDir', $ConfigDir, '-NonInteractive')
        if ($Force) { $arguments += '-Force' }
        $output = & $script:Shell @arguments *>&1 | Out-String
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    }

    function Read-SettingFile([string]$ConfigDir) {
        Get-Content -Raw -LiteralPath (Join-Path $ConfigDir 'settings.json') | ConvertFrom-Json
    }

    function Get-Backup([string]$ConfigDir) {
        @(Get-ChildItem -LiteralPath $ConfigDir -Filter 'settings.json.bak-*')
    }

    # the package script with its version line replaced
    function Write-VersionedScript([string]$Path, [string]$Version, [string]$Extra = '') {
        $text = (Get-Content -Raw -LiteralPath $script:Source) -replace '(?m)^// version: .*$', "// version: $Version"
        [System.IO.File]::WriteAllText($Path, $text + $Extra, (New-Object System.Text.UTF8Encoding($false)))
    }
}

Describe 'install.ps1' {
    BeforeEach {
        $scriptDir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $configDir = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $scriptDir, $configDir | Out-Null
        $installed = Join-Path $scriptDir 'statusline.mjs'
    }

    Context 'on a clean machine' {
        It 'installs the script and points settings.json at it with an absolute path' {
            $run = Invoke-Installer $scriptDir $configDir
            $run.ExitCode | Should -Be 0 -Because $run.Output
            (Get-FileHash $installed).Hash | Should -Be (Get-FileHash $script:Source).Hash

            $settings = Read-SettingFile $configDir
            $settings.statusLine.type | Should -Be 'command'
            $expected = 'node "' + ((Resolve-Path $installed).Path -replace '\\', '/') + '"'
            $settings.statusLine.command | Should -Be $expected
            Get-Backup $configDir | Should -HaveCount 0
        }

        It 'finishes with a successful test run' {
            $run = Invoke-Installer $scriptDir $configDir
            $run.Output | Should -Match 'Opus \(sample\)'
            $run.Output | Should -Match 'Done\.'
        }
    }

    Context 'with an existing settings.json' {
        It 'changes only statusLine, keeps its other options and writes a backup' {
            # Path and PATH differ only in case: Windows PowerShell 5.1 ConvertFrom-Json
            # rejects that, which is why the installer lets node edit the file
            $original = @'
{
  "model": "opus",
  "env": { "Path": "a", "PATH": "b" },
  "statusLine": { "type": "command", "command": "node old.mjs", "padding": 1 }
}
'@
            Set-Content -LiteralPath (Join-Path $configDir 'settings.json') -Value $original -NoNewline

            $run = Invoke-Installer $scriptDir $configDir
            $run.ExitCode | Should -Be 0 -Because $run.Output
            $run.Output | Should -Match 'replaced the previous status line \(node old\.mjs\)'

            $text = Get-Content -Raw -LiteralPath (Join-Path $configDir 'settings.json')
            $text | Should -Match '"Path": "a"'
            $text | Should -Match '"PATH": "b"'
            $text | Should -Match '"model": "opus"'
            $text | Should -Match '"padding": 1'
            $text | Should -Not -Match 'old\.mjs'

            $backups = Get-Backup $configDir
            $backups | Should -HaveCount 1
            Get-Content -Raw -LiteralPath $backups[0].FullName | Should -Be $original
        }

        It 'leaves everything untouched on a second run' {
            Invoke-Installer $scriptDir $configDir | Out-Null
            $settingsFile = Join-Path $configDir 'settings.json'
            $before = Get-Content -Raw -LiteralPath $settingsFile

            $run = Invoke-Installer $scriptDir $configDir
            $run.ExitCode | Should -Be 0
            $run.Output | Should -Match 'already configured'
            $run.Output | Should -Match 'already up to date'
            Get-Content -Raw -LiteralPath $settingsFile | Should -Be $before
            Get-Backup $configDir | Should -HaveCount 0
        }

        It 'refuses to touch a settings.json that is not valid JSON, and says so in the exit code' {
            $settingsFile = Join-Path $configDir 'settings.json'
            Set-Content -LiteralPath $settingsFile -Value '{ "model": ' -NoNewline

            $run = Invoke-Installer $scriptDir $configDir
            $run.ExitCode | Should -Be 2
            $run.Output | Should -Match 'not a valid JSON object'
            Get-Content -Raw -LiteralPath $settingsFile | Should -Be '{ "model": '
        }
    }

    Context 'with a script already installed' {
        It 'keeps a newer installed script' {
            Write-VersionedScript $installed '99.0.0'
            $before = (Get-FileHash $installed).Hash

            $run = Invoke-Installer $scriptDir $configDir
            $run.ExitCode | Should -Be 0 -Because $run.Output
            $run.Output | Should -Match 'NEWER \(99\.0\.0\)'
            (Get-FileHash $installed).Hash | Should -Be $before
        }

        It 'keeps a script of the same version that was edited by hand' {
            Write-VersionedScript $installed ((Select-String -LiteralPath $script:Source -Pattern '^// version: (.+)$').Matches[0].Groups[1].Value) '// local tweak'
            $before = (Get-FileHash $installed).Hash

            $run = Invoke-Installer $scriptDir $configDir
            $run.Output | Should -Match 'edited by hand'
            (Get-FileHash $installed).Hash | Should -Be $before
        }

        It 'replaces a newer script when forced' {
            Write-VersionedScript $installed '99.0.0'
            $run = Invoke-Installer $scriptDir $configDir -Force
            $run.ExitCode | Should -Be 0 -Because $run.Output
            (Get-FileHash $installed).Hash | Should -Be (Get-FileHash $script:Source).Hash
        }

        It 'upgrades an older script, and one that predates version lines' {
            Write-VersionedScript $installed '0.9.0'
            (Invoke-Installer $scriptDir $configDir).Output | Should -Match 'was 0\.9\.0'
            (Get-FileHash $installed).Hash | Should -Be (Get-FileHash $script:Source).Hash

            Set-Content -LiteralPath $installed -Value 'console.log("old")'
            (Invoke-Installer $scriptDir $configDir).Output | Should -Match 'unversioned'
            (Get-FileHash $installed).Hash | Should -Be (Get-FileHash $script:Source).Hash
        }
    }
}
