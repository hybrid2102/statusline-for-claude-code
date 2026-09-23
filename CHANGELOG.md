# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Segments are separated by a plain two-space gap instead of a dimmed `│`: each segment
  already opens with its own emoji, and the line gains a column per segment before it has
  to shorten anything.

## [1.0.0] - 2026-09-23

First public release.

### Added

- **Budget light.** For both rate-limit windows (5 hours and 7 days), the status line
  projects where usage will be at reset if the current pace holds, and sums it up in one
  light: green to push harder, yellow to keep going, red to slow down. Each window shows
  usage, projection and time to reset. Pay-as-you-go accounts see the session cost instead.
- **Context size in tokens**, yellow past 200k tokens or 70% and red past 90%, with a
  warning when the prompt cache has gone cold and the next message will resend the whole
  context at full price.
- **Git state** with branch, worktree, pending changes and distance from upstream in grey,
  and red reserved for what blocks: conflicts, an operation left half-way (rebase, merge,
  cherry-pick, revert, bisect) and a deleted upstream.
- **Model, effort and output style** in one segment, with fast mode highlighted.
- **Account and profile**, to tell apart windows running on different Claude Code profiles.
- **Width-aware layout**: when the terminal is narrow, segments are shortened before any is
  dropped, and the budget is the last to go.
- **Windows installer** (`install.bat` / `install.ps1`) that configures one or several
  profiles, edits only the `statusLine` key of `settings.json` with a timestamped backup,
  refuses to replace a newer or hand-edited script without confirmation, and finishes with
  a test run. Supports `-ConfigDir`, `-ScriptDir`, `-Force` and `-NonInteractive`.
- **`claude-profile.bat`** to start Claude Code on an alternative profile, with a
  confirmation before a mistyped name creates an empty one.

[Unreleased]: https://github.com/hybrid2102/statusline-for-claude-code/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hybrid2102/statusline-for-claude-code/releases/tag/v1.0.0
