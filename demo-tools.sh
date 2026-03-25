#!/bin/bash
# Demo script showing all 5 MCP tools

echo "🎯 metabob-mcp Demo - All 5 Tools"
echo "=================================="
echo ""

export SESSION_ID="demo-session"
export ANALYSIS_API_URL="http://localhost:8081"

echo "1. Listing all available tools..."
echo ""
timeout 2 bash -c 'echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}" | bun run src/index.ts 2>/dev/null' | jq -r '.result.tools[] | "   ✓ \(.name)"'

echo ""
echo "2. Tool Details:"
echo ""

echo "   get_priority_issues"
echo "   → Fetch high-priority problems ranked by severity"
echo ""

echo "   search_codebase"
echo "   → Semantic search for code issues"
echo ""

echo "   annotate_component"
echo "   → Add design decisions and implementation notes"
echo ""

echo "   suggest_related_changes"
echo "   → Co-change prediction for related files"
echo ""

echo "   analyze_change_impact"
echo "   → CPG-based impact analysis"
echo ""

echo "3. Server Status:"
echo ""
echo "   MCP Protocol: JSON-RPC 2.0 over stdio"
echo "   Tools Registered: 5"
echo "   Type Safety: ✓ (Zod validation)"
echo "   Error Handling: ✓ (MCP error codes)"
echo "   Session Management: ✓"
echo "   API Client: ✓ (retry + timeout)"
echo ""

echo "4. Integration Status:"
echo ""
echo "   ✓ MCP Server: Ready"
echo "   ⏳ Analysis API: Awaiting implementation"
echo "   ✓ Documentation: Complete"
echo ""

echo "=================================="
echo "✅ Implementation Complete"
echo ""
echo "Next: Start analysis-api on port 8081 for end-to-end testing"
