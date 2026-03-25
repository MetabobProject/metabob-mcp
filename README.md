# metabob-mcp

MCP server exposing Metabob analysis capabilities to AI agents (Claude, Cursor, etc.).

## Overview

This MCP server provides 7 core tools for code analysis:

1. **get_priority_issues** - Fetch high-priority problems ranked by severity and impact
2. **search_codebase** - Semantic search for code issues using natural language
3. **annotate_component** - Add design decisions and implementation notes to code
4. **suggest_related_changes** - Co-change prediction for incomplete changes
5. **analyze_change_impact** - Impact analysis via Code Property Graph traversal
6. **mark_problem_complete** - Mark a problem as resolved with optional commit reference
7. **generate_implementation_spec** - Generate detailed implementation plans from goals

## Installation

### For End Users (via npx)

No installation required! Run directly with npx:

```bash
npx @metabob/metabob-mcp@latest --api-url=http://localhost:8081 --session-id=my-session
```

### For Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/metabob/metabob-devbob.git
cd metabob-devbob/repos/metabob-mcp
bun install
```

## Configuration

Environment variables:

- `ANALYSIS_API_URL`: Backend API URL (default: `http://localhost:8081`)
- `SESSION_ID`: Session identifier (default: `default-session`)
- `LOG_LEVEL`: Logging level - `debug`, `info`, `warn`, `error` (default: `info`)
- `HEALTH_PORT`: HTTP port for health checks (default: `8080`)
- `MAX_REQUESTS_PER_MINUTE`: Rate limit per session (default: `60`)

## Usage

### Quick Start with npx

Run the MCP server directly:

```bash
# With defaults (connects to http://localhost:8081)
npx @metabob/metabob-mcp@latest

# With custom API URL
npx @metabob/metabob-mcp@latest --api-url=http://api.example.com:8081

# With custom session and debug logging
npx @metabob/metabob-mcp@latest \
  --session-id=my-session \
  --log-level=debug \
  --health-port=8080

# Show help
npx @metabob/metabob-mcp@latest --help

# Show version
npx @metabob/metabob-mcp@latest --version
```

### Command-Line Options

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `--api-url` | `ANALYSIS_API_URL` | `http://localhost:8081` | Backend API URL |
| `--session-id` | `SESSION_ID` | `default-session` | Session identifier |
| `--log-level` | `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `--health-port` | `HEALTH_PORT` | `8080` | HTTP port for health checks |
| `--max-requests-per-minute` | `MAX_REQUESTS_PER_MINUTE` | `60` | Rate limit per session |

Note: Command-line options take precedence over environment variables.

### Development Mode

For local development:

```bash
# Start server with Bun
bun run start

# Watch mode (auto-reload on changes)
bun run dev
```

The server communicates via stdio using JSON-RPC 2.0 protocol.

### Test Tool Registration

```bash
bun run test-mcp-server.ts
```

This tests that all tools are registered correctly and validates input schemas.

### Manual Testing with JSON-RPC

List available tools:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | bun run src/index.ts
```

Call a tool:

```bash
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_priority_issues","arguments":{"limit":5}}}' | SESSION_ID=test-session bun run src/index.ts
```

## Tools Reference

### 1. get_priority_issues

Fetch high-priority analysis issues for current codebase.

**Parameters:**
- `limit` (number, optional): Max issues to return (default: 10, max: 100)
- `severity` (string[], optional): Filter by severity (CRITICAL, HIGH, MEDIUM, LOW, INFO)
- `category` (string[], optional): Filter by category (security, performance, etc.)
- `scope` (string, optional): Analysis scope (session, project, org)

**Example:**
```json
{
  "limit": 5,
  "severity": ["HIGH", "CRITICAL"],
  "scope": "session"
}
```

### 2. search_codebase

Search for code issues using natural language queries.

**Parameters:**
- `query` (string, required): Natural language search query
- `limit` (number, optional): Max results (default: 10)
- `filters` (object, optional): Additional filters
  - `severity` (string[]): Filter by severity
  - `category` (string[]): Filter by category
  - `file_pattern` (string): Glob pattern (e.g., "src/**/*.ts")
  - `scope` (string): Analysis scope

**Example:**
```json
{
  "query": "find authentication bugs",
  "limit": 5,
  "filters": {
    "severity": ["HIGH"],
    "scope": "session"
  }
}
```

### 3. annotate_component

Add annotations to code components.

**Parameters:**
- `component_id` (string, required): Component ID from CPG
- `content` (string, required): Annotation text
- `type` (string, required): Type (design_decision, implementation_note, bug_context, todo)
- `tags` (string[], optional): Tags for categorization
- `link_to_problem_id` (string, optional): Link to a problem

**Example:**
```json
{
  "component_id": "src/auth.ts::function::login::15",
  "content": "Added rate limiting to prevent brute force attacks",
  "type": "implementation_note",
  "tags": ["security"]
}
```

### 4. suggest_related_changes

Suggest files that should be changed together.

**Parameters:**
- `changed_files` (string[], required): Files being changed
- `limit` (number, optional): Max suggestions (default: 5)
- `confidence_threshold` (number, optional): Min confidence (0.0-1.0, default: 0.3)
- `config` (object, optional): Scoring weights
  - `embedding_weight` (number): Semantic similarity weight (default: 0.6)
  - `frequency_weight` (number): Historical frequency weight (default: 0.4)

**Example:**
```json
{
  "changed_files": ["src/auth/login.ts"],
  "limit": 5,
  "confidence_threshold": 0.5
}
```

### 5. analyze_change_impact

Analyze impact of code changes via CPG traversal.

**Parameters:**
- `changed_files` (string[], required): Files being changed
- `diff` (string, optional): Git diff output
- `direction` (string, optional): Traverse direction (forward, backward, both)
- `max_depth` (number, optional): Max traversal depth (default: 5)
- `include_tests` (boolean, optional): Include test files (default: true)

**Example:**
```json
{
  "changed_files": ["src/auth/login.ts"],
  "direction": "both",
  "max_depth": 5,
  "include_tests": true
}
```

### 6. mark_problem_complete

Mark a code problem as resolved with optional commit reference.

**Parameters:**
- `problem_id` (string, required): Problem ID to mark as complete
- `resolution_summary` (string, required): Summary of how the problem was resolved
- `fixed_in_commit` (string, optional): Git commit SHA or reference
- `create_annotation` (boolean, optional): Auto-create annotation documenting fix (default: true)

**Example:**
```json
{
  "problem_id": "prob_123",
  "resolution_summary": "Fixed SQL injection by using parameterized queries",
  "fixed_in_commit": "abc123",
  "create_annotation": true
}
```

### 7. generate_implementation_spec

Generate detailed implementation specification from a high-level goal.

**Parameters:**
- `goal` (string, required): High-level goal or feature description
- `entry_points` (string[], optional): Starting files/components to analyze
- `context` (string, optional): Additional context about the codebase

**Example:**
```json
{
  "goal": "Add user authentication with JWT tokens",
  "entry_points": ["src/api/server.ts"],
  "context": "Using Express.js and PostgreSQL database"
}
```

**Note:** Large responses (>100KB) are automatically truncated with a warning.

## Architecture

```
AI Agent (Claude, Cursor)
         ↓ MCP Protocol (JSON-RPC over stdio)
   metabob-mcp (this server)
         ↓ HTTP/JSON
   metabob-analysis-api
         ↓
   @metabob/cpg-inference
```

## Error Handling

The server maps API errors to MCP error codes:

| API Status | MCP Error Code | Description |
|-----------|---------------|-------------|
| 400 | INVALID_PARAMS | Invalid request parameters |
| 401 | UNAUTHORIZED | Missing or invalid session ID |
| 404 | NOT_FOUND | Component or resource not found |
| 429 | RATE_LIMITED | Too many requests |
| 500 | SERVICE_UNAVAILABLE | Analysis API error |

All errors include helpful suggestions for resolution.

## Features

### Rate Limiting
- 60 requests per minute per session (configurable)
- Automatic retry-after calculation
- Per-session tracking

### Circuit Breaker
- Opens after 5 consecutive API failures
- Automatic recovery after 60 seconds
- Half-open state for testing recovery

### Health Checks
- HTTP endpoint on port 8080 (configurable)
- `/health` - Liveness probe (checks circuit breaker state)
- `/ready` - Readiness probe (checks if server can accept requests)

### Error Handling
- MCP-compliant error codes
- Helpful error messages with suggestions
- Structured error logging

## Development

### Type Checking

```bash
bun run typecheck
```

### Build

```bash
bun run build
```

Output will be in `dist/` directory.

### Docker Build

```bash
docker build -t metabob-mcp:latest .
```

Image size: ~284MB

### Docker Run

```bash
docker run -it --rm \
  -e ANALYSIS_API_URL=http://host.docker.internal:8081 \
  -e SESSION_ID=docker-session \
  -p 8080:8080 \
  metabob-mcp:latest
```

Test health endpoint:
```bash
curl http://localhost:8080/health
```

### Kubernetes Deployment

Deploy to Kubernetes cluster:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: metabob-mcp
  namespace: metabob
spec:
  replicas: 2
  selector:
    matchLabels:
      app: metabob-mcp
  template:
    metadata:
      labels:
        app: metabob-mcp
    spec:
      containers:
      - name: metabob-mcp
        image: metabob-mcp:latest
        imagePullPolicy: IfNotPresent
        env:
        - name: ANALYSIS_API_URL
          value: "http://metabob-analysis-api:8080"
        - name: SESSION_ID
          value: "kubernetes-session"
        - name: LOG_LEVEL
          value: "info"
        - name: HEALTH_PORT
          value: "8080"
        ports:
        - containerPort: 8080
          name: health
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 30
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 2
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "500m"
        securityContext:
          runAsNonRoot: true
          runAsUser: 1001
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
---
apiVersion: v1
kind: Service
metadata:
  name: metabob-mcp
  namespace: metabob
spec:
  selector:
    app: metabob-mcp
  ports:
  - name: health
    port: 8080
    targetPort: 8080
    protocol: TCP
  type: ClusterIP
```

Apply the deployment:

```bash
kubectl apply -f metabob-mcp-deployment.yaml

# Verify deployment
kubectl get pods -n metabob -l app=metabob-mcp

# Check logs
kubectl logs -n metabob -l app=metabob-mcp -f

# Test health endpoint
kubectl port-forward -n metabob svc/metabob-mcp 8080:8080
curl http://localhost:8080/health
```

## Integration with MCP Clients

### Claude Desktop

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": [
        "@metabob/metabob-mcp@latest",
        "--api-url=http://localhost:8081",
        "--session-id=claude-session",
        "--log-level=info"
      ]
    }
  }
}
```

### Cursor IDE

Create or update `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": [
        "@metabob/metabob-mcp@latest",
        "--api-url=http://localhost:8081",
        "--session-id=cursor-session"
      ]
    }
  }
}
```

### Continue (VS Code Extension)

Add to Continue config (`~/.continue/config.json`):

```json
{
  "mcpServers": [
    {
      "name": "metabob",
      "command": "npx",
      "args": [
        "@metabob/metabob-mcp@latest",
        "--api-url=http://localhost:8081"
      ]
    }
  ]
}
```

### Generic MCP Client

Any MCP client can use npx to run the server:

```json
{
  "command": "npx",
  "args": ["@metabob/metabob-mcp@latest", "--api-url=<YOUR_API_URL>"]
}
```

## Publishing to npm

### Prerequisites

1. npm account with publish access to `@metabob` organization
2. Logged in via `npm login`

### Publishing Steps

```bash
# 1. Update version in package.json
npm version patch  # or minor, major

# 2. Build and run checks (automatic via prepublishOnly)
npm run build

# 3. Test the package locally
npm pack
# This creates @metabob-metabob-mcp-X.Y.Z.tgz

# 4. Test installation from tarball
npm install -g ./metabob-metabob-mcp-X.Y.Z.tgz
metabob-mcp --help

# 5. Publish to npm
npm publish

# 6. Verify installation
npx @metabob/metabob-mcp@latest --version
```

### Version Guidelines

- **Patch** (0.1.X): Bug fixes, documentation updates
- **Minor** (0.X.0): New features, backward-compatible changes
- **Major** (X.0.0): Breaking changes

### Troubleshooting Publish

If publish fails:

```bash
# Check if you're logged in
npm whoami

# Verify package name is available
npm info @metabob/metabob-mcp

# Check package contents
npm pack --dry-run

# Verify build output
ls -la dist/
```

## License

Private - Metabob Inc.
