# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-09-24

### Added

- **`/statusline-update`**, a Claude Code command that installs the latest release from
  inside a session. The script downloads the release and refuses it unless it matches the
  release's `SHA256SUMS.txt` and version, and runs correctly on sample data. It keeps the
  previous version as a backup, and Claude then tells you what changed. The installer adds
  the command to each profile it configures. The same update is available from a terminal
  as `node statusline.mjs --update`.
- **`🆕 v1.3.0 /statusline-update`** at the end of the line when a newer release is out.
  A background process checks GitHub at most once a day, so the line never waits for the
  network; `STATUSLINE_NO_UPDATE_CHECK=1` turns the check off. It is the first segment to
  shorten and the first to go on a narrow terminal.
- `node statusline.mjs --version` prints the installed version.

This release has to be installed with `install.bat` once more. From then on,
`/statusline-update` takes care of it.

## [1.1.1] - 2026-09-24

### Fixed

- The time to reset of each budget window is shown in parentheses, `5h 20%→40% (2h30m)`,
  instead of after a `↺` symbol: several terminal fonts draw the symbol wider than its
  column, so it overlapped the digits that followed.

## [1.1.0] - 2026-09-23

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

[Unreleased]: https://github.com/hybrid2102/statusline-for-claude-code/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/hybrid2102/statusline-for-claude-code/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/hybrid2102/statusline-for-claude-code/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/hybrid2102/statusline-for-claude-code/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hybrid2102/statusline-for-claude-code/releases/tag/v1.0.0
