#!/bin/bash
# Test metabob-mcp server locally against deployed API

set -e

# Configuration
export ANALYSIS_API_URL="http://metabob-analysis-api.activity-system.svc.cluster.local:8080"
export SESSION_ID="local-test-session-$(date +%s)"
export LOG_LEVEL="debug"
export HEALTH_PORT="8092"

echo "=== Testing metabob-mcp server locally ==="
echo "API URL: $ANALYSIS_API_URL"
echo "Session ID: $SESSION_ID"
echo ""

# Use kubectl port-forward to access the service
echo "Setting up port-forward to analysis API..."
kubectl port-forward -n activity-system svc/metabob-analysis-api 8083:8080 &
PF_PID=$!
sleep 3

# Override API URL to use port-forward
export ANALYSIS_API_URL="http://localhost:8083"

echo "Starting MCP server..."
echo "Press Ctrl+C to stop"
echo ""

# Cleanup on exit
cleanup() {
    echo ""
    echo "Cleaning up..."
    kill $PF_PID 2>/dev/null || true
    exit 0
}
trap cleanup EXIT INT TERM

# Run the server
bun run src/index.ts
