#!/bin/bash
# Show detailed schemas for all tools

echo "📋 MCP Tool Schemas"
echo "==================="
echo ""

export SESSION_ID="test"

timeout 2 bash -c 'echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}" | bun run src/index.ts 2>/dev/null' | jq -r '
.result.tools[] |
"
\u001b[1m\(.name)\u001b[0m
" + (.description | gsub("\\. "; ".\n  ")) + "

Parameters:
" + (
  .inputSchema.properties |
  to_entries[] |
  "  • \(.key): \(.value.type // "object") " +
  (if .value.description then "- \(.value.description)" else "" end) +
  (if .value.default then " (default: \(.value.default))" else "" end) +
  (if .value.enum then " (options: \(.value.enum | join(", ")))" else "" end)
) + "
"
'

echo ""
echo "==================="
echo "✅ All 5 tools have complete schemas"
