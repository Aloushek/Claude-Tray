#!/usr/bin/env bash
# claude-tray-status.sh — statusLine hook for Claude-Tray
#
# Claude Code calls this periodically with JSON on stdin containing:
#   rate_limits.5h.percent, rate_limits.5h.remainingTime (or resetIn)
#   rate_limits.7d.percent
#   cost, model, context_window
#
# Writes ~/.claude/notifications/.rate_limits.json for the extension to read.
# Also outputs the status line text back to Claude Code (shown in status bar).

set -u

NOTIF_DIR="${HOME}/.claude/notifications"
mkdir -p "${NOTIF_DIR}"

JSON=$(cat)

# Log raw data for schema discovery (kept small, auto-rotated)
LOG="${NOTIF_DIR}/.statusline.log"
if [[ -f "${LOG}" ]] && [[ $(stat -c%s "${LOG}" 2>/dev/null || echo 0) -gt 10240 ]]; then
    tail -n 20 "${LOG}" > "${LOG}.tmp" && mv "${LOG}.tmp" "${LOG}"
fi
echo "[$(date -Iseconds)] ${JSON}" >> "${LOG}"

if [[ -z "${JSON}" ]] || ! command -v jq &>/dev/null; then
    exit 0
fi

# Write structured data for extension
echo "${JSON}" | jq '{
    rate_limits: .rate_limits,
    cost: .cost,
    model: .model,
    context_window: .context_window,
    updatedAt: now | floor * 1000
}' > "${NOTIF_DIR}/.rate_limits.json" 2>/dev/null || true

# Output text for Claude Code status line (shown in terminal status bar)
# Format: "5h:45% 7d:23%"
STATUS=$(echo "${JSON}" | jq -r '
    def pct(x): if x then "\(x | round)%" else "?" end;
    [
        if .rate_limits["5h"] then "5h:\(pct(.rate_limits["5h"].percent))" else empty end,
        if .rate_limits["7d"] then "7d:\(pct(.rate_limits["7d"].percent))" else empty end
    ] | join(" | ")
' 2>/dev/null) || STATUS=""

[[ -n "${STATUS}" ]] && echo "${STATUS}"

exit 0
