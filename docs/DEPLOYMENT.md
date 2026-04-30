# metabob-mcp Deployment Guide

## Quick Start

### Build Docker Image
```bash
cd repos/metabob-mcp
docker build -t metabob-mcp:latest .
```

### Deploy to Kubernetes
```bash
cd ../../helm
helmfile -f activity-system-minimal.yaml.gotmpl sync
```

### Verify Deployment
```bash
kubectl get pods -n activity-system -l app.kubernetes.io/name=metabob-mcp
kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-mcp
```

## Configuration

### Environment Variables

- `ANALYSIS_API_URL` - URL of metabob-analysis-api (default: http://metabob-analysis-api:8080)
- `SESSION_ID` - Session identifier for tracking (default: docker-session)
- `LOG_LEVEL` - Logging level: info, debug, error (default: info)
- `HEALTH_PORT` - Health check server port (default: 8080)
- `MAX_REQUESTS_PER_MINUTE` - Rate limit per session (default: 60)

### Helm Values

Customize via `helm/charts/metabob-mcp/values.yaml`:

```yaml
replicaCount: 1

image:
  repository: metabob-mcp
  pullPolicy: Always
  tag: "latest"

config:
  analysisApiUrl: "http://metabob-analysis-api.activity-system.svc.cluster.local:8080"
  sessionId: "mcp-server-session"
  logLevel: "info"
  maxRequestsPerMinute: 60

resources:
  requests:
    memory: "128Mi"
    cpu: "50m"
  limits:
    memory: "256Mi"
    cpu: "200m"
```

## Access

### Internal (from within cluster)
```
http://metabob-mcp.activity-system.svc.cluster.local:8080
```

### External (requires /etc/hosts)
```
http://mcp.minibob.local
```

Add to `/etc/hosts`:
```
127.0.0.1  mcp.minibob.local
```

### Port Forward (testing)
```bash
kubectl port-forward -n activity-system svc/metabob-mcp 8090:8080
curl http://localhost:8090/health
```

## Available Tools

The MCP server exposes 7 tools:

1. **get_priority_issues** - Retrieve high-priority code issues with filtering
2. **search_codebase** - Search codebase using semantic or text queries
3. **annotate_component** - Add metadata annotations to code components
4. **suggest_related_changes** - Suggest related code modifications based on changes
5. **analyze_change_impact** - Analyze the impact of proposed code changes
6. **mark_problem_complete** - Mark detected problems as resolved
7. **generate_implementation_spec** - Generate implementation specifications for features

## Health Monitoring

### Health Endpoint
```bash
curl http://mcp.minibob.local/health
```

Response:
```json
{
  "status": "healthy",
  "circuitState": "CLOSED",
  "timestamp": "2026-03-24T16:27:21.854Z"
}
```

### Circuit Breaker States
- `CLOSED` - Normal operation
- `OPEN` - Service unavailable (too many failures)
- `HALF_OPEN` - Testing recovery

### Check Logs
```bash
kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-mcp -f
```

## Troubleshooting

### Pod Not Starting
```bash
kubectl describe pod -n activity-system -l app.kubernetes.io/name=metabob-mcp
kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-mcp
```

### Analysis API Connection Failed
Check if metabob-analysis-api is running:
```bash
kubectl get pods -n activity-system -l app.kubernetes.io/name=metabob-analysis-api
```

Test connectivity:
```bash
kubectl exec -n activity-system -it $(kubectl get pod -n activity-system -l app.kubernetes.io/name=metabob-mcp -o jsonpath='{.items[0].metadata.name}') -- sh
# Inside pod:
wget -O- http://metabob-analysis-api.activity-system.svc.cluster.local:8080/health
```

### Rate Limit Exceeded
Wait for rate limit window to reset (60 seconds) or increase `MAX_REQUESTS_PER_MINUTE`.

### Circuit Breaker Open
The circuit breaker opens after 5 consecutive failures. It will automatically reset after 60 seconds if the Analysis API becomes healthy.

## Scaling

### Horizontal Scaling
```bash
kubectl scale deployment -n activity-system metabob-mcp --replicas=3
```

Or update Helm values:
```yaml
replicaCount: 3
```

### Resource Tuning
Monitor resource usage:
```bash
kubectl top pods -n activity-system -l app.kubernetes.io/name=metabob-mcp
```

Adjust resources in values.yaml as needed.

## Maintenance

### Update Docker Image
```bash
cd repos/metabob-mcp
docker build -t metabob-mcp:latest .
kubectl rollout restart deployment -n activity-system metabob-mcp
```

### View Deployment Status
```bash
kubectl rollout status deployment -n activity-system metabob-mcp
```

### Rollback
```bash
kubectl rollout undo deployment -n activity-system metabob-mcp
```

## Integration

### Use with AI Agents

The MCP server follows the Model Context Protocol specification. Configure your AI agent to connect via:

**Transport:** stdio or HTTP
**Endpoint:** http://metabob-mcp.activity-system.svc.cluster.local:8080

Example MCP client configuration:
```json
{
  "mcpServers": {
    "metabob": {
      "url": "http://mcp.minibob.local",
      "transport": "http"
    }
  }
}
```

### MiniBob Integration

MiniBob can use the MCP server via the MCP client. The metabob-activity-api already includes MCP integration for tool calling.

## Security

### Production Considerations

1. **Authentication:** Add API key authentication
2. **TLS:** Enable HTTPS with certificates
3. **Network Policies:** Restrict pod-to-pod communication
4. **Resource Limits:** Set appropriate CPU/memory limits
5. **Rate Limiting:** Adjust per-session limits based on usage

### Secrets Management

For production, store sensitive configuration in Kubernetes secrets:
```bash
kubectl create secret generic metabob-mcp-config \
  --from-literal=analysis-api-key="your-api-key" \
  -n activity-system
```

## Uninstall

### Remove Deployment
```bash
helm uninstall metabob-mcp -n activity-system
```

### Remove Docker Image
```bash
docker rmi metabob-mcp:latest
```

## Support

For issues or questions:
- Check logs: `kubectl logs -n activity-system -l app.kubernetes.io/name=metabob-mcp`
- View events: `kubectl get events -n activity-system --field-selector involvedObject.name=metabob-mcp`
- Review README: `repos/metabob-mcp/README.md`
