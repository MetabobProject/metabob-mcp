# Quick Start Guide

Get started with `@metabob/metabob-mcp` in under 5 minutes.

## Installation

No installation required! Run directly with npx:

```bash
npx @metabob/metabob-mcp@latest --help
```

## Basic Usage

### 1. Start the MCP Server

```bash
npx @metabob/metabob-mcp@latest --api-url=http://localhost:8081
```

The server will:
- Connect to the Metabob Analysis API at the specified URL
- Start listening for MCP requests on stdin/stdout
- Expose 7 code analysis tools to AI agents

### 2. Configure Your AI Tool

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": [
        "@metabob/metabob-mcp@latest",
        "--api-url=http://localhost:8081"
      ]
    }
  }
}
```

Restart Claude Desktop.

#### Cursor IDE

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "metabob": {
      "command": "npx",
      "args": [
        "@metabob/metabob-mcp@latest",
        "--api-url=http://localhost:8081"
      ]
    }
  }
}
```

Restart Cursor.

### 3. Test the Connection

In Claude or Cursor, try asking:

> "What are the highest priority code issues in this project?"

> "Search for security vulnerabilities in authentication code"

> "Analyze the impact of changing the login function"

## Available Tools

1. **get_priority_issues** - Get high-priority problems
2. **search_codebase** - Semantic code search
3. **annotate_component** - Add design notes
4. **suggest_related_changes** - Co-change prediction
5. **analyze_change_impact** - CPG-based impact analysis
6. **mark_problem_complete** - Mark issues as resolved
7. **generate_implementation_spec** - Generate implementation plans

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `--api-url` | `http://localhost:8081` | Analysis API endpoint |
| `--session-id` | `default-session` | Session identifier |
| `--log-level` | `info` | Logging level (debug, info, warn, error) |
| `--health-port` | `8080` | HTTP health check port |
| `--max-requests-per-minute` | `60` | Rate limit |

## Common Issues

### "Connection refused" error

The Analysis API is not running. Start it first:

```bash
# Check if API is running
curl http://localhost:8081/health

# If not, start the analysis API
# (instructions depend on your setup)
```

### "Rate limit exceeded" error

Too many requests. Options:

1. Wait 60 seconds for the rate limit to reset
2. Increase limit: `--max-requests-per-minute=120`

### "Circuit breaker open" error

The API had multiple failures. The circuit breaker will automatically reset after 60 seconds.

## Next Steps

- Read the full [README.md](./README.md) for detailed tool documentation
- Check [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment options
- See [PUBLISHING.md](./PUBLISHING.md) for publishing guidelines

## Support

For issues or questions:
- GitHub Issues: https://github.com/metabob/metabob-devbob/issues
- Documentation: https://github.com/metabob/metabob-devbob/tree/main/repos/metabob-mcp
