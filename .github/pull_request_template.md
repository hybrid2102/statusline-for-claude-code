## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The reasoning a reviewer cannot get from the diff: what decision the change helps the
     user make, the terminal or platform quirk you worked around, the case not covered. -->

## Checks

- [ ] `npm test` passes
- [ ] `Invoke-Pester -Path ./tests` passes, if the installer changed
- [ ] `Invoke-ScriptAnalyzer -Path . -Recurse -Settings ./PSScriptAnalyzerSettings.psd1` is clean
- [ ] Tried the status line in a real Claude Code session
- [ ] The version line in `statusline.mjs` and `package.json` is unchanged, or bumped in both
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`, if this is user-visible
