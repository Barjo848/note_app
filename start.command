#!/bin/bash
# start.command — serves the app and opens Track.
# Loop Lab is http://localhost:8000/?library=<name> when that name is listed.
# Close this window (or Ctrl-C) to stop the server.
cd "$(dirname "$0")"
PORT=8000
if ! command -v node >/dev/null 2>&1; then echo "node is not installed (brew install node)"; read -n1 -p "press a key"; exit 1; fi
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT already in use — opening the browser only"; else node tools/serve.js $PORT & SERVER=$!; sleep 0.6; fi
URL="http://localhost:$PORT/"
open -a "Google Chrome" "$URL" 2>/dev/null || open -a "Brave Browser" "$URL" 2>/dev/null || open "$URL"
echo "Note running at $URL — leave this window open while you work."
[ -n "$SERVER" ] && wait $SERVER
