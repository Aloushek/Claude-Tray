#!/usr/bin/env bash
# install-hooks.sh — idempotently installs Claude Code hooks for Claude-Tray
#
# Installs hooks that track working/waiting/idle state:
#   UserPromptSubmit → working   (user submitted a prompt, Claude is processing)
#   PreToolUse       → working   (Claude is about to use a tool)
#   Notification     → waiting   (Claude asks for input or permission)
#   Stop             → clear     (Claude finished its turn, awaiting user)
#   SessionEnd       → clear     (session ended)
#
# Safe to re-run — removes existing claude-tray hooks first, then adds fresh ones.

set -euo pipefail

SETTINGS_FILE="${HOME}/.claude/settings.json"
INSTALL_DIR="${HOME}/.local/share/claude-tray"
NOTIFY_SCRIPT="${INSTALL_DIR}/claude-tray-notify.sh"
HOOKS_SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-tray-notify.sh"

if ! command -v jq &> /dev/null; then
    echo "Error: jq is required. Install with: sudo apt install jq" >&2
    exit 1
fi

# Install notify script to a stable location
mkdir -p "${INSTALL_DIR}"
cp "${HOOKS_SOURCE}" "${NOTIFY_SCRIPT}"
chmod +x "${NOTIFY_SCRIPT}"
echo "Installed notify script → ${NOTIFY_SCRIPT}"

# Ensure settings file exists
if [[ ! -f "${SETTINGS_FILE}" ]]; then
    echo '{}' > "${SETTINGS_FILE}"
    echo "Created ${SETTINGS_FILE}"
fi

# Remove any existing claude-tray hooks first (for clean re-install)
TMP=$(mktemp)
jq '
    if .hooks then
        .hooks |= with_entries(
            .value |= map(
                .hooks |= map(select(.command // "" | contains("claude-tray-notify") | not))
            )
            | .value |= map(select(.hooks | length > 0))
        )
        | .hooks |= with_entries(select(.value | length > 0))
    else . end
' "${SETTINGS_FILE}" > "${TMP}"
mv "${TMP}" "${SETTINGS_FILE}"

# Build fresh hook entries
# Note: no matcher means the hook fires for all events of that type
build_hook() {
    local action="$1"
    cat <<EOF
{
  "hooks": [
    {
      "type": "command",
      "command": "${NOTIFY_SCRIPT} ${action}"
    }
  ]
}
EOF
}

WORKING_HOOK=$(build_hook "working")
WAITING_HOOK=$(build_hook "waiting")
CLEAR_HOOK=$(build_hook "clear")

# Merge hooks into settings.json
TMP=$(mktemp)
jq --argjson working "${WORKING_HOOK}" \
   --argjson waiting "${WAITING_HOOK}" \
   --argjson clear   "${CLEAR_HOOK}" \
   '
   .hooks = (.hooks // {})
   | .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + [$working])
   | .hooks.PreToolUse       = ((.hooks.PreToolUse       // []) + [$working])
   | .hooks.Notification     = ((.hooks.Notification     // []) + [$waiting])
   | .hooks.Stop             = ((.hooks.Stop             // []) + [$clear])
   | .hooks.SessionEnd       = ((.hooks.SessionEnd       // []) + [$clear])
   ' "${SETTINGS_FILE}" > "${TMP}"

if jq empty "${TMP}" 2>/dev/null; then
    mv "${TMP}" "${SETTINGS_FILE}"
    echo "Hooks installed in ${SETTINGS_FILE}:"
    echo "  UserPromptSubmit → working"
    echo "  PreToolUse       → working"
    echo "  Notification     → waiting"
    echo "  Stop             → clear (back to idle)"
    echo "  SessionEnd       → clear (session ended)"
    echo ""
    echo "Restart any running Claude Code sessions for hooks to take effect."
else
    rm -f "${TMP}"
    echo "Error: jq produced invalid JSON — aborting." >&2
    exit 1
fi
