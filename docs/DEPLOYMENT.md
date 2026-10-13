# Deployment

`@metabob/mcp` runs as a stdio MCP server, a client of the substrate it is configured with. The same
binary serves an HTTP resolver on `127.0.0.1:HEALTH_PORT` for callers in its own network namespace; it
registers nowhere, so nothing outside reaches it.

## Docker

```bash
docker build -t metabob-mcp:latest .
docker run --rm \
  -e METABOB_API_KEY=mb_... \
  -e METABOB_ENDPOINT=http://substrate-host:18080 \
  -e DISCOVERY_ENDPOINT=http://substrate-host:18100 \
  -e METABOB_STDIO_KEEPALIVE=1 \
  metabob-mcp:latest
```

`METABOB_STDIO_KEEPALIVE=1` is mandatory for any headless run. Without it the
process treats stdin EOF as "the MCP client that owns my lifetime died" and
shuts down — a container started without an attached stdin exits at once.
The resolver binds the container's loopback, so publishing its port reaches
nothing; the image's healthcheck runs inside the container.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOB_API_KEY` | — | API key, sent as `Authorization: ApiKey` on every substrate request. Absent ⇒ local tools only, and one startup message names the missing key |
| `METABOB_ENDPOINT` | — | Substrate endpoint. A local `…:18080` derives discovery and concept-db; a remote one derives nothing. Absent ⇒ local tools only, and one startup message names it |
| `DISCOVERY_ENDPOINT` | _(derived)_ | Discovery-vessel base URL for substrate routing; required with a remote endpoint |
| `IDENTITY_ENDPOINT` | — | Identity vessel (tenant resolution); unset ⇒ skipped |
| `METABOB_STDIO_KEEPALIVE` | — | `1` keeps the process alive with stdin closed. Required for headless / container runs |
| `SESSION_ID` | _(fresh UUID)_ | Session identifier |
| `HEALTH_PORT` | _(ephemeral)_ | Port of the loopback HTTP resolver (the Docker image pins `8080`) |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | Rate limit per session |

## Health

```bash
curl http://127.0.0.1:8080/health
# {"status":"healthy","circuitState":"CLOSED","attachment":{"attached":true,"advertised":"none (client-only)"},"timestamp":"..."}

curl http://127.0.0.1:8080/v2/capabilities
# {"id":"metabob-mcp","version":"...","shapes":[...],"protocols":["mcp:stdio","http:resolver"],"tools":[...],"resolver":{...}}
```

Circuit breaker states: `CLOSED` (normal) → `OPEN` (5 consecutive failures; auto-resets after 60s) → `HALF_OPEN` (recovery probe).

