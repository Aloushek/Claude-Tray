#!/usr/bin/env bash
# claude-tray-notify.sh — Claude Code hook handler for Claude-Tray

set -u

ACTION="${1:-}"
if [[ -z "${ACTION}" ]]; then
    echo "[claude-tray-notify] usage: $0 <working|waiting|clear>" >&2
    exit 1
fi

NOTIF_DIR="${HOME}/.claude/notifications"
mkdir -p "${NOTIF_DIR}"

# Read JSON from stdin (non-blocking)
JSON=""
if read -t 1 -r line 2>/dev/null; then
    JSON="${line}"
    while read -t 0.1 -r line 2>/dev/null; do
        JSON="${JSON}${line}"
    done
fi

# Extract session_id
SESSION_ID=""
if [[ -n "${JSON}" ]] && command -v jq &>/dev/null; then
    SESSION_ID=$(jq -r '.session_id // empty' <<<"${JSON}" 2>/dev/null) || SESSION_ID=""
fi
[[ -z "${SESSION_ID}" ]] && SESSION_ID="${CLAUDE_SESSION_ID:-}"

# Rotate log at 50KB
LOG_FILE="${NOTIF_DIR}/.debug.log"
if [[ -f "${LOG_FILE}" ]] && [[ $(stat -c%s "${LOG_FILE}" 2>/dev/null || echo 0) -gt 51200 ]]; then
    tail -n 100 "${LOG_FILE}" > "${LOG_FILE}.tmp" 2>/dev/null && mv "${LOG_FILE}.tmp" "${LOG_FILE}"
fi
echo "[$(date -Iseconds)] action=${ACTION} sid=${SESSION_ID} json=${JSON}" >> "${LOG_FILE}"

[[ -z "${SESSION_ID}" ]] && exit 0

NOTIF_FILE="${NOTIF_DIR}/${SESSION_ID}.json"
TS=$(date +%s%3N)

case "${ACTION}" in
    working)
        printf '{"sessionId":"%s","status":"working","timestamp":%s}\n' \
            "${SESSION_ID}" "${TS}" > "${NOTIF_FILE}"
        ;;

    waiting)
        # Only set "waiting" (red) when Claude is genuinely BLOCKED on user action.
        # Primary signal: notification_type == "permission_prompt"
        # Fallback: message content keywords for older Claude Code versions.
        NEEDS_ACTION=0

        if [[ -n "${JSON}" ]] && command -v jq &>/dev/null; then
            # Check notification_type field (reliable, Claude Code 1.x+)
            NOTIF_TYPE=$(jq -r '.notification_type // empty' <<<"${JSON}" 2>/dev/null) || NOTIF_TYPE=""
            if [[ "${NOTIF_TYPE}" == "permission_prompt" ]]; then
                NEEDS_ACTION=1
            elif [[ -n "${NOTIF_TYPE}" ]]; then
                # Known non-blocking type (e.g. idle_prompt) — skip
                NEEDS_ACTION=0
            else
                # No notification_type — fall back to message keyword matching
                MSG=$(jq -r '.message // .title // ""' <<<"${JSON}" 2>/dev/null | tr '[:upper:]' '[:lower:]') || MSG=""
                if [[ -n "${MSG}" ]]; then
                    case "${MSG}" in
                        *permission*|*approve*|*allow*|*blocked*|*confirm*|*y/n*|*yes/no*)
                            NEEDS_ACTION=1 ;;
                    esac
                else
                    # Empty message — can't tell, assume needs action
                    NEEDS_ACTION=1
                fi
            fi
        else
            # No jq — assume needs action
            NEEDS_ACTION=1
        fi

        if [[ "${NEEDS_ACTION}" -eq 1 ]]; then
            printf '{"sessionId":"%s","status":"waiting","timestamp":%s}\n' \
                "${SESSION_ID}" "${TS}" > "${NOTIF_FILE}"
        fi
        ;;

    clear)
        rm -f "${NOTIF_FILE}"
        ;;

    *)
        echo "[claude-tray-notify] Unknown action: ${ACTION}" >&2
        exit 1
        ;;
esac

exit 0
