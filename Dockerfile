# Multi-stage Dockerfile for metabob-mcp
# Target image size: <200MB

# Stage 1: Build
FROM oven/bun:1 AS build

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install every dependency: the build bundles the dev ones into dist/
RUN bun install --frozen-lockfile

# Copy source code and vendor dependencies
COPY src ./src
COPY vendor ./vendor
COPY scripts ./scripts
COPY tsconfig.json ./

# Build the application (uses bun run build which produces dist/cli.js)
RUN bun run build

# The runtime needs only the packages the build keeps external (package.json dependencies)
RUN rm -rf node_modules && bun install --frozen-lockfile --production --no-optional

# Stage 2: Production image
FROM oven/bun:1-slim AS production

WORKDIR /app

# git: the ledger is keyed by the mounted repository's origin (else its first commit), and a close reads its commits
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy built application and dependencies from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Note: Running as root in container. For production, configure
# Kubernetes SecurityContext to run as non-root user (runAsUser: 1001)

# Environment variables (can be overridden). SESSION_ID is left unset, so each container gets a fresh one; the
# resolver port is fixed for the healthcheck, outside the substrate's 8000-8999 container ports.
ENV LOG_LEVEL=info
ENV HEALTH_PORT=18800
ENV MAX_REQUESTS_PER_MINUTE=60

# The HTTP resolver binds 127.0.0.1 only, so the port is not exposed: the
# healthcheck runs inside the container's own network namespace.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:18800/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the MCP server (dist/cli.js, from bun run build)
CMD ["bun", "run", "dist/cli.js"]
