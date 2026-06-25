# Deployment

`@metabob/mcp` runs as a stdio MCP server. For server-side or container deployments the same binary also exposes an HTTP vessel server on `HEALTH_PORT`.

## Docker

```bash
docker build -t metabob-mcp:latest .
docker run --rm \
  -e METABOB_API_KEY=mb_... \
  -e ANALYSIS_API_URL=https://ide.metabob.com \
  -e HEALTH_PORT=8080 \
  -p 8080:8080 \
  metabob-mcp:latest
```

## Kubernetes / Helm

```bash
helmfile -f helm/activity-system-minimal.yaml.gotmpl sync
kubectl get pods -n activity-system -l app.kubernetes.io/name=metabob-mcp
```

Helm values (`helm/charts/metabob-mcp/values.yaml`):

```yaml
image:
  repository: metabob-mcp
  tag: "latest"

config:
  analysisApiUrl: "https://ide.metabob.com"
  logLevel: "info"
  maxRequestsPerMinute: 60

resources:
  requests:
    memory: "256Mi"
    cpu: "100m"
  limits:
    memory: "512Mi"
    cpu: "500m"

secrets:
  metabobApiKey: "mb_..."
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `METABOB_API_KEY` | — | **Required.** Exchanged for a session token on startup |
| `ANALYSIS_API_URL` | `https://ide.metabob.com` | Analysis API base URL |
| `DISCOVERY_ENDPOINT` | — | Discovery-vessel base URL for substrate routing |
| `IDENTITY_ENDPOINT` | `https://identity.metabob.com` | Identity vessel |
| `ACTIVITY_ENDPOINT` | `https://activity.metabob.com` | Discovery vessel |
| `SESSION_ID` | `default-session` | Session identifier |
| `HEALTH_PORT` | `8080` | Vessel HTTP server port |
| `VESSEL_ENDPOINT` | `http://localhost:$HEALTH_PORT` | This vessel's reachable URL |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |
| `MAX_REQUESTS_PER_MINUTE` | `60` | Rate limit per session |
| `SUBMIT_TIMEOUT_MS` | `120000` | Timeout for `init_workspace` file submission before treating the backend as slow |

## Health

```bash
curl http://localhost:8080/health
# {"status":"healthy","circuitState":"CLOSED","timestamp":"..."}

curl http://localhost:8080/v2/capabilities
# {"vesselId":"metabob-mcp","shapes":[...]}
```

Circuit breaker states: `CLOSED` (normal) → `OPEN` (5 consecutive failures; auto-resets after 60s) → `HALF_OPEN` (recovery probe).

## Kubernetes ops

```bash
# Port-forward for local testing
kubectl port-forward -n activity-system svc/metabob-mcp 8090:8080

# Logs
kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-mcp -f

# Restart
kubectl rollout restart deployment -n activity-system metabob-mcp

# Rollback
kubectl rollout undo deployment -n activity-system metabob-mcp
```
