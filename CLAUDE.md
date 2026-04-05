# metabob-mcp Development Guidelines

## Overview

MCP (Model Context Protocol) server that exposes Metabob code analysis capabilities to AI agents. Enables IDE integrations to access analysis, search, and annotation features.

> **Canonical reference**: `docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md`

## Available Tools

### 1. get_priority_issues
Fetch high-priority analysis issues for current codebase.

**When to use:** Start of debugging or code review sessions to identify critical problems.

**Parameters:**
- `limit` (number, optional): Max issues to return (default: 10, max: 100)
- `severity` (array, optional): Filter by severity (LOW, MEDIUM, HIGH, CRITICAL)
- `category` (array, optional): Filter by category
- `scope` (string, optional): Analysis scope (session, project, org)

### 2. search_codebase
Semantic search through detected code issues.

**When to use:** Looking for specific types of issues or patterns in the codebase.

**Parameters:**
- `query` (string): Search query (natural language)
- `limit` (number, optional): Max results (default: 10, max: 50)
- `scope` (string, optional): Analysis scope
- `file_pattern` (string, optional): Glob pattern to filter files
- `severity` (array, optional): Filter by severity

### 3. annotate_component
Add human annotations to code components.

**When to use:** Document decisions, explanations, or context for future reference.

**Parameters:**
- `component_id` (string): Component identifier
- `content` (string): Annotation text
- `type` (string): Annotation type (documentation, decision, explanation, todo)
- `tags` (array, optional): Categorization tags
- `problem_id` (string, optional): Link to related problem

### 4. suggest_related_changes
Co-change prediction for current changes.

**When to use:** Before committing to identify files that should be updated together.

**Parameters:**
- `changed_files` (array): Files being modified
- `files` (array, optional): Candidate files to check
- `top_k` (number, optional): Number of suggestions (default: 10)
- `threshold` (number, optional): Confidence threshold (0-1, default: 0.5)

### 5. analyze_change_impact
Graph-based impact analysis for proposed changes.

**When to use:** Before making changes to understand downstream effects.

**Parameters:**
- `changed_files` (array): Files to be modified
- `diff` (string, optional): Git diff content
- `max_depth` (number, optional): Graph traversal depth (default: 3)
- `direction` (string, optional): Analysis direction (downstream, upstream, both)

### 6. mark_problem_complete
Mark a code problem as resolved.

**When to use:** After fixing a bug or implementing a suggested improvement.

**Parameters:**
- `problem_id` (string): Problem identifier
- `resolution_summary` (string): How the problem was resolved
- `fixed_in_commit` (string, optional): Git commit SHA
- `create_annotation` (boolean, optional): Auto-create annotation (default: true)

### 7. generate_implementation_spec
Generate detailed implementation specification from high-level goal.

**When to use:** Starting new feature or refactoring to get structured implementation plan.

**Parameters:**
- `goal` (string): High-level goal or feature description
- `entry_points` (array, optional): Starting files/components to analyze
- `context` (string, optional): Additional context about requirements

## Workflow Examples

### Debugging Workflow
1. `get_priority_issues` - Identify critical issues
2. `search_codebase` - Find related problems
3. Fix the code
4. `mark_problem_complete` - Mark as resolved

### Code Review Workflow
1. `suggest_related_changes` - Check for missing updates
2. `analyze_change_impact` - Understand downstream effects
3. `annotate_component` - Document decisions

### Feature Development Workflow
1. `generate_implementation_spec` - Get structured plan
2. `analyze_change_impact` - Identify affected components
3. Implement the feature
4. `suggest_related_changes` - Verify all updates made

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `METABOB_API_KEY` | API key for authentication | (recommended) |
| `ANALYSIS_API_URL` | Backend API URL | `http://localhost:8081` |
| `SESSION_ID` | Session identifier | `default-session` |
| `LOG_LEVEL` | Logging level | `info` |
| `MAX_REQUESTS_PER_MINUTE` | Rate limit | `60` |
| `JWT_TOKEN` | JWT token (advanced) | - |
| `HEALTH_PORT` | HTTP port for health checks | `8080` |

## Authentication

### API Key Authentication (Recommended)

Use `METABOB_API_KEY` or `--api-key` for authentication. The API key is exchanged for a short-lived JWT token on startup, with automatic refresh every 12 minutes.

Get your API key from: https://app.metabob.com/settings/api-keys

**Example with CLI:**
```bash
npx @metabob/metabob-mcp --api-key=mb_live_your_api_key_here
```

**Example with environment:**
```bash
export METABOB_API_KEY="mb_live_your_api_key_here"
npx @metabob/metabob-mcp
```

This enables:
- Multi-tenant data isolation via SurrealDB RBAC
- Org/project-scoped activity templates and execution traces
- Access to private templates within your organization
- Automatic token refresh (no manual token management)

### JWT Authentication (Advanced)

For advanced use cases, you can provide a JWT token directly via `JWT_TOKEN` or `--jwt-token`. This bypasses API key exchange but requires manual token refresh.

```bash
npx @metabob/metabob-mcp --jwt-token=eyJhbGciOiJIUzI1NiIs...
```

## Error Handling

The server includes:
- **Rate limiting:** 60 requests/minute per session
- **Circuit breaker:** Opens after 5 consecutive API failures
- **Graceful degradation:** Helpful error messages with suggestions

## Development

```bash
# Install dependencies
bun install

# Run in development
bun run dev

# Run tests
bun test

# Build for distribution
bun run build

# Type checking
bun run typecheck
```

## CI/CD Integration

### Before Push

```bash
bun test        # Tests must pass
bun run lint    # Linting must pass
```

### Publishing

This package is published to npm as `@metabob/metabob-mcp`. Version bumps and publishing are handled via CI.

## Bun Development

Default to Bun for all operations:

```bash
bun <file>              # Run TypeScript directly
bun test                # Run tests
bun run dev             # Development mode
bun install             # Install dependencies
```

## Related Documentation

- [IMPULSE_ACTIVITY_FOUNDATION.md](../../docs/architecture/IMPULSE_ACTIVITY_FOUNDATION.md)
- [Root CLAUDE.md](../../CLAUDE.md)
