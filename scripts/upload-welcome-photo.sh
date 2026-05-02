#!/usr/bin/env bash
# One-shot helper: upload the /start welcome photo to your bot and print
# the Telegram file_id so you can drop it into the WELCOME_PHOTO_FILE_ID
# env var on the telegram-webhook Edge Function.
#
# Usage:
#   BOT_TOKEN=123:abc... ADMIN_CHAT_ID=945676433 \
#     bash scripts/upload-welcome-photo.sh path/to/welcome.png

set -euo pipefail

TOKEN="${BOT_TOKEN:?Set BOT_TOKEN env var}"
CHAT="${ADMIN_CHAT_ID:?Set ADMIN_CHAT_ID env var (your Telegram numeric ID)}"
FILE="${1:?Pass path to the welcome PNG as the first argument}"

if [[ ! -f "$FILE" ]]; then
  echo "File not found: $FILE" >&2
  exit 1
fi

echo "Uploading $FILE to chat $CHAT ..."

response=$(curl -sS -F "chat_id=$CHAT" -F "photo=@$FILE" \
  "https://api.telegram.org/bot$TOKEN/sendPhoto")

# Prefer python (with json), fall back to a regex grep if python is missing.
if command -v python >/dev/null 2>&1; then
  echo "$response" | python -c '
import json, sys
d = json.load(sys.stdin)
if not d.get("ok"):
    print("ERROR:", d, file=sys.stderr)
    sys.exit(1)
photos = d["result"]["photo"]
biggest = sorted(photos, key=lambda p: p.get("file_size", 0))[-1]
print()
print("==========================================================")
print("file_id:")
print(biggest["file_id"])
print("==========================================================")
print()
print("Set this in Supabase Edge Function secrets as:")
print("  WELCOME_PHOTO_FILE_ID=" + biggest["file_id"])
'
else
  echo "$response"
  echo "Install python to extract file_id automatically. For now, copy the"
  echo "biggest 'file_id' from the JSON output above."
fi
