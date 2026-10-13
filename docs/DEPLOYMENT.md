# Deployment

`@metabob/mcp` runs as a stdio MCP server. For server-side or container deployments the same binary also exposes an HTTP vessel server on `HEALTH_PORT`.

## Docker

```bash
docker build -t metabob-mcp:latest .
docker run --rm \
  -e METABOB_API_KEY=mb_... \
  -e METABOB_ENDPOINT=https://ide.metabob.com \
  -e HEALTH_PORT=8080 \
  -e METABOB_STDIO_KEEPALIVE=1 \
  -p 8080:8080 \
  metabob-mcp:latest
```

`METABOB_STDIO_KEEPALIVE=1` is mandatory for any headless run. Without it the
process treats stdin EOF as "the MCP client that owns my lifetime died" and
shuts down — a container started without an attached stdin exits at once,
leaving the HTTP vessel server unreachable.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOB_API_KEY` | — | Exchanged for a session token on startup. Absent ⇒ anonymous mode: the local tools work, telemetry is off, and the vessel does not register |
| `METABOB_ENDPOINT` | `https://ide.metabob.com` | Gateway everything else derives from (analysis, discovery, identity, concept-db) |
| `METABOB_STDIO_KEEPALIVE` | — | `1` keeps the process alive with stdin closed. Required for headless / container runs |
| `METABOB_STATELESS` | — | `true` leaves `LocalStore` unconstructed: no local findings for `record_finding` / `get_problems`, and no agent-resolver queue |
| `ANALYSIS_API_URL` | _(derived from `METABOB_ENDPOINT`)_ | Analysis API base URL override |
| `IDENTITY_ENDPOINT` | `https://ide.metabob.com/identity` | Identity vessel (tenant resolution) |
| `DISCOVERY_ENDPOINT` | _(derived)_ | Discovery-vessel base URL for substrate routing |
| `SESSION_ID` | _(fresh UUID)_ | Session identifier |
| `HEALTH_PORT` | `8080` | Vessel HTTP server port |
| `VESSEL_PUBLIC_ENDPOINT` | `http://127.0.0.1:$HEALTH_PORT` | Reachable base URL advertised for inbound HTTP resolves |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | Rate limit per session |

## Health

```bash
curl http://localhost:8080/health
# {"status":"healthy","circuitState":"CLOSED","timestamp":"..."}

curl http://localhost:8080/v2/capabilities
# {"id":"metabob-mcp","version":"...","shapes":[...],"protocols":["mcp:stdio","http:resolver"],"tools":[...],"resolver":{...}}
```

Circuit breaker states: `CLOSED` (normal) → `OPEN` (5 consecutive failures; auto-resets after 60s) → `HALF_OPEN` (recovery probe).

