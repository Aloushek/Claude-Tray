#!/usr/bin/env bash
# claude-tray-status.sh — statusLine hook for Claude-Tray
#
# Claude Code calls this periodically with a JSON object on stdin.
# Current schema (Claude Code 2.x):
#   .rate_limits.five_hour.{used_percentage, resets_at}
#   .rate_limits.seven_day.{used_percentage, resets_at}
#   .cost.total_cost_usd
#   .model.display_name
#   .context_window.{used_percentage, remaining_percentage}
#
# Writes ~/.claude/notifications/.rate_limits.json for the extension to read.
# Also outputs the status line text back to Claude Code (shown in status bar).

set -u

NOTIF_DIR="${HOME}/.claude/notifications"
mkdir -p "${NOTIF_DIR}"

JSON=$(cat)

# Log raw data for schema discovery (auto-rotated at 10KB)
LOG="${NOTIF_DIR}/.statusline.log"
if [[ -f "${LOG}" ]] && [[ $(stat -c%s "${LOG}" 2>/dev/null || echo 0) -gt 10240 ]]; then
    tail -n 20 "${LOG}" > "${LOG}.tmp" && mv "${LOG}.tmp" "${LOG}"
fi
echo "[$(date -Iseconds)] ${JSON}" >> "${LOG}"

if [[ -z "${JSON}" ]] || ! command -v jq &>/dev/null; then
    exit 0
fi

# Write per-session context window usage (each session has its own ctx)
SESSION_ID=$(echo "${JSON}" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
if [[ -n "${SESSION_ID}" ]]; then
    echo "${JSON}" | jq '{
        ctx_pct:         (.context_window.used_percentage // null),
        transcript_path: (.transcript_path // null),
        session_name:    (.session_name // null),
        updatedAt:       (now | floor | . * 1000)
    }' > "${NOTIF_DIR}/${SESSION_ID}.ctx.json.tmp" 2>/dev/null \
        && mv "${NOTIF_DIR}/${SESSION_ID}.ctx.json.tmp" "${NOTIF_DIR}/${SESSION_ID}.ctx.json" || true
fi

# Normalize and write structured data for the extension.
# Maps Claude Code's current schema → stable internal format.
echo "${JSON}" | jq '{
    rate_limits: {
        "5h": (
            if .rate_limits.five_hour then {
                percent:    .rate_limits.five_hour.used_percentage,
                resets_at:  .rate_limits.five_hour.resets_at
            } else null end
        ),
        "7d": (
            if .rate_limits.seven_day then {
                percent:    .rate_limits.seven_day.used_percentage,
                resets_at:  .rate_limits.seven_day.resets_at
            } else null end
        )
    },
    cost:      (.cost.total_cost_usd // null),
    model:     (.model.display_name // .model.id // null),
    updatedAt: (now | floor | . * 1000)
}' > "${NOTIF_DIR}/.rate_limits.json.tmp" 2>/dev/null \
    && mv "${NOTIF_DIR}/.rate_limits.json.tmp" "${NOTIF_DIR}/.rate_limits.json" \
    || true

# Build status line string for Claude Code's terminal status bar.
# Format: "5h:9% rst 2h30m | 7d:86% | ctx:28%"
NOW=$(date +%s)

STATUS=$(echo "${JSON}" | jq -r --argjson now "${NOW}" '
    def pct(x): if x != null then "\(x | round)%" else "?" end;

    def reset_in(ts):
        if ts != null then
            (ts - $now) as $sec |
            if $sec <= 0 then "now"
            elif $sec < 3600 then "\($sec / 60 | floor)m"
            else
                ($sec / 3600 | floor) as $h |
                ($sec % 3600 / 60 | floor) as $m |
                if $m > 0 then "\($h)h\($m)m" else "\($h)h" end
            end
        else null end;

    [
        if .rate_limits.five_hour then
            "5h:\(pct(.rate_limits.five_hour.used_percentage))" +
            (reset_in(.rate_limits.five_hour.resets_at) | if . then " rst \(.)" else "" end)
        else empty end,

        if .rate_limits.seven_day then
            "7d:\(pct(.rate_limits.seven_day.used_percentage))"
        else empty end,

        if .context_window.used_percentage != null then
            "ctx:\(.context_window.used_percentage | round)%"
        else empty end
    ] | join(" | ")
' 2>/dev/null) || STATUS=""

[[ -n "${STATUS}" ]] && echo "${STATUS}"

exit 0
