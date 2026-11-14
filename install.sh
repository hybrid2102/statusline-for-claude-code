#!/bin/sh
# Installs or updates the Claude Code status line on macOS and Linux.
# Runs install.ps1, the same installer Windows uses, with PowerShell 7 (pwsh), and passes
# its options on: sh install.sh -ConfigDir ~/.claude-work -NonInteractive
# Needs statusline.mjs and install.ps1 in this same folder.

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1

if ! command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell 7 (pwsh) is not installed, and the installer needs it." >&2
  echo "Install it (https://learn.microsoft.com/powershell/scripting/install/installing-powershell)" >&2
  echo "or install the status line by hand:" >&2
  echo "https://github.com/hybrid2102/statusline-for-claude-code#manual-install" >&2
  exit 1
fi

exec pwsh -NoProfile -File "$dir/install.ps1" "$@"
