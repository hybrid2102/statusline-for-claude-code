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

It makes **no network requests** and sends no telemetry.

**Debug mode** is the one exception to "nothing is written": while a file named
`statusline.debug` exists in your profile folder, each input is copied to
`claude-statusline-input.json` in your temp folder. Delete `statusline.debug` to stop it.

## What the installer changes

- Copies `statusline.mjs` to `~/.claude` (or `-ScriptDir`).
- Sets the `statusLine` key of each chosen profile's `settings.json`, after writing a
  timestamped backup next to it. No other key is modified.
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
