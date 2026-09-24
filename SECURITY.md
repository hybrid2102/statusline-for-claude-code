# Security

A status line runs on every refresh of every Claude Code session, with your user's
permissions. That deserves a plain statement of what it touches.

## What the status line reads and runs

- **The JSON Claude Code sends on stdin.** It includes paths, the session name and usage
  figures. Nothing from it is written anywhere, except when you enable debug mode (below).
- **`.claude.json` of the active profile**, only to read the `oauthAccount.emailAddress`
  field. Nothing else in the file is used, and no credential is read: OAuth tokens live in
  a separate file this project never opens.
- **`git status --porcelain --branch`** in the current folder, run with
  `--no-optional-locks` so it never takes the index lock, and a few `stat` calls inside
  `.git` to detect a rebase or merge in progress.

It sends no telemetry. Its network requests all go to GitHub, and only for updates:

- **The daily check.** At most once a day, a detached background process asks
  `api.github.com` for the latest release of this project. The request carries nothing
  about you or your sessions. The result is saved to `statusline-update.json` next to the
  script. Set `STATUSLINE_NO_UPDATE_CHECK=1` to turn the check off.
- **`--update` (the `/statusline-update` command)**, only when you run it. It downloads
  `statusline.mjs` and `SHA256SUMS.txt` from the latest release, and refuses the script
  unless its SHA-256 matches, its version line matches the release tag and a test run on
  sample data succeeds. The previous script is kept as `statusline.mjs.bak-<version>`.
  The changelog is then read from `raw.githubusercontent.com` to report what changed.

The checksum proves that the download is intact and is the file CI published with the
release. It cannot protect against a compromise of the GitHub repository itself, which
downloading the release by hand would not protect against either.

Apart from the update check, the script writes nothing unless you enable **debug mode**:
while a file named `statusline.debug` exists in your profile folder, each input is copied
to `claude-statusline-input.json` in your temp folder. Delete `statusline.debug` to stop
it.

## What the installer changes

- Copies `statusline.mjs` to `~/.claude` (or `-ScriptDir`).
- Sets the `statusLine` key of each chosen profile's `settings.json`, after writing a
  timestamped backup next to it. No other key is modified.
- Writes `skills/statusline-update/SKILL.md` in each chosen profile. Its `allowed-tools`
  pre-approves exactly one command, `node "<script>" --update`, and
  `disable-model-invocation` means only you can start it.
- Never elevates itself and never touches anything outside those folders.

## Verifying a download

Every release is built by CI from a tagged commit and ships `SHA256SUMS.txt`:

```powershell
Get-FileHash .\statusline-for-claude-code-v1.0.0.zip -Algorithm SHA256
```

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Reporting a vulnerability

Open a [security advisory](https://github.com/hybrid2102/statusline-for-claude-code/security/advisories/new),
or a regular issue if the matter is not sensitive.

## Supported versions

Only the latest release receives fixes.
