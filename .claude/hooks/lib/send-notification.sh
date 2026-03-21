#!/bin/bash
# send-notification.sh — Config-driven notification from hooks
# Replaces send-telegram-ipc.sh with channel abstraction
# Usage: source this file, then call send_notification "message"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/read-config.sh"

send_notification() {
  local message="$1"
  local channel="${KAIZEN_NOTIFICATION_CHANNEL:-none}"

  case "$channel" in
    telegram)
      _send_telegram_notification "$message"
      ;;
    none|"")
      # Silent — log only
      return 0
      ;;
    *)
      echo "kaizen: unknown notification channel '$channel'" >&2
      return 1
      ;;
  esac
}

_send_telegram_notification() {
  local message="$1"

  # Read telegram-specific config
  local ipc_dir
  ipc_dir=$(jq -r '.notifications.config.ipcDir // "data/ipc/main/messages"' "$KAIZEN_CONFIG" 2>/dev/null)
  local group_jid
  group_jid=$(jq -r '.notifications.config.groupJid // ""' "$KAIZEN_CONFIG" 2>/dev/null)

  local full_ipc_dir="$KAIZEN_PROJECT_ROOT/$ipc_dir"

  if [ ! -d "$full_ipc_dir" ]; then
    # IPC directory doesn't exist — can't send
    return 0
  fi

  local timestamp
  timestamp=$(date +%s%N | cut -b1-13)
  local filename="kaizen-${timestamp}.json"

  local jid="${group_jid}"
  if [ -z "$jid" ]; then
    # No JID configured — can't send
    return 0
  fi

  cat > "$full_ipc_dir/$filename" <<NOTIF_EOF
{
  "type": "message",
  "jid": "$jid",
  "text": "$message"
}
NOTIF_EOF
}
