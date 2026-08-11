#!/usr/bin/env bash
# MemPeek in 3 lines: see the ZTMR primitive, wire it into Claude Code, open the dashboard.
# Run from the repo root after `git clone`.
set -euo pipefail
npm install && npm run build && node dist/index.js --demo        # 1) watch the split-return + budget
claude mcp add mempeek node "$(pwd)/dist/index.js"               # 2) wire MemPeek into Claude Code
node dist/index.js --http-only & sleep 1 && open http://localhost:7331   # 3) the recall dashboard
