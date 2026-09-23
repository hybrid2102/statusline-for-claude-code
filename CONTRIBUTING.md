# Contributing

Thanks for taking the time. This is a small, opinionated tool, so the bar is simple:

- **Every segment must lead to a decision.** Information you would read and then do
  nothing about is noise, however interesting. This is why session duration and lines
  changed are not shown.
- **Colour means "look here".** In normal conditions the line stays grey; yellow and red
  are reserved for what needs attention. A change that colours a normal state will be
  asked about.
- **No dependencies.** The status line is a single file running on plain Node.js 18+, and
  the installer on the Windows PowerShell 5.1 that ships with every Windows machine.

## Development setup

No build step and nothing to install for the status line itself. For the installer tests
you need the two modules the CI uses:

```powershell
Install-Module Pester -MinimumVersion 5.5.0 -Scope CurrentUser
Install-Module PSScriptAnalyzer -Scope CurrentUser
```

To try a change live, point your own `settings.json` at your working copy:

```json
"statusLine": { "type": "command", "command": "node \"C:/path/to/statusline-for-claude-code/statusline.mjs\"" }
```

To see what Claude Code actually sends, create an empty `statusline.debug` in your profile
folder: each input is then saved to `claude-statusline-input.json` in your temp folder.
New fields appear there first.

## Before opening a pull request

Run what CI runs:

```sh
npm test
```

```powershell
Invoke-Pester -Path ./tests -Output Detailed
Invoke-ScriptAnalyzer -Path . -Recurse -Settings ./PSScriptAnalyzerSettings.psd1
```

All three must be clean. If an analyzer rule genuinely does not apply, exclude it in
`PSScriptAnalyzerSettings.psd1` **with a comment explaining why**.

## House style

- **Comments explain why, not what.** A comment earns its place by recording the reason
  for a non-obvious choice: a terminal quirk, a field Claude Code sends in an unexpected
  shape, a failure seen in practice.
- **Pure functions are exported and tested.** Anything that touches the machine (git, the
  account file, the clock, the terminal width) is passed to `render()` through its `env`
  argument so tests can replace it.
- **The installer is ASCII-only** and Windows PowerShell 5.1 compatible: no ternaries, no
  null-coalescing, no three-argument `Join-Path`. Accented characters need a BOM to survive
  5.1, and it is not worth the trap. CI checks both.
- Line endings for `.ps1`, `.psd1` and `.bat` are pinned to CRLF by `.gitattributes`.

## Changelog

User-visible changes go in `CHANGELOG.md` under `## [Unreleased]`, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Cutting a release

Releases are built and published by CI. There is nothing to build by hand.

1. Bump the version in **both** the `// version:` line at the top of `statusline.mjs` and
   `package.json`. The installer compares that line to decide whether it may overwrite an
   installed copy, so it must be right.
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` into a `## [X.Y.Z] - YYYY-MM-DD`
   section and update the links at the bottom.
3. Commit, then push an annotated tag:

   ```sh
   git tag -a v1.2.3 -m "v1.2.3 - short summary"
   git push origin v1.2.3
   ```

The release workflow refuses to publish unless the tag, the script, `package.json` and the
changelog agree and the tests pass. It then builds the zip, installs it once into throwaway
folders to prove it works, attaches `SHA256SUMS.txt` and creates the GitHub release.
