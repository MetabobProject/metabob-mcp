# Multi-stage Dockerfile for metabob-mcp
# Target image size: <200MB

# Stage 1: Build
FROM oven/bun:1 AS build

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies (production only, no optional deps)
RUN bun install --frozen-lockfile --production --no-optional

# Copy source code and vendor dependencies
COPY src ./src
COPY vendor ./vendor
COPY scripts ./scripts
COPY tsconfig.json ./

# Build the application (uses bun run build which produces dist/cli.js)
RUN bun run build 2>/dev/null || bun build src/index.ts --target=bun --outdir=dist --external onnxruntime-node --external tree-sitter --external tree-sitter-javascript --external tree-sitter-python --external tree-sitter-typescript

# Stage 2: Production image
FROM oven/bun:1-slim AS production

WORKDIR /app

# Copy built application and dependencies from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Note: Running as root in container. For production, configure
# Kubernetes SecurityContext to run as non-root user (runAsUser: 1001)

# Environment variables (can be overridden)
ENV ANALYSIS_API_URL=http://metabob-analysis-api:8080
ENV SESSION_ID=docker-session
ENV LOG_LEVEL=info
ENV HEALTH_PORT=8080
ENV MAX_REQUESTS_PER_MINUTE=60

# Expose health check port
EXPOSE 8080

# Health check (using Bun's fetch instead of curl)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun run -e "fetch('http://localhost:8080/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run MCP server (dist/cli.js produced by bun run build; dist/index.js fallback)
CMD ["bun", "run", "dist/cli.js"]
