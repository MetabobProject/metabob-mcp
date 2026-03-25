# metabob-mcp - Usage Instructions for AI Agents

This MCP server exposes Metabob code analysis capabilities to AI agents. Use these tools to analyze code, find issues, and generate implementation specifications.

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

## Error Handling

The server includes:
- **Rate limiting:** 60 requests/minute per session
- **Circuit breaker:** Opens after 5 consecutive API failures
- **Graceful degradation:** Helpful error messages with suggestions

## Environment Variables

- `METABOB_API_KEY`: API key for authentication (recommended)
- `ANALYSIS_API_URL`: Backend API URL (default: http://localhost:8081)
- `SESSION_ID`: Session identifier (default: default-session)
- `LOG_LEVEL`: Logging level (info, debug, error)
- `MAX_REQUESTS_PER_MINUTE`: Rate limit (default: 60)
- `JWT_TOKEN`: JWT token for multi-tenant authentication (advanced, use API key instead)
- `HEALTH_PORT`: HTTP port for health checks (default: 8080)

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

---

## Bun-Specific Instructions

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
