#!/usr/bin/env node
/**
 * MCP Server for Metabob Analysis API
 * Exposes code analysis tools to AI agents via MCP protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { AnalysisAPIClient } from './api-client.js';
import { SessionManager } from './session-manager.js';
import { TOOL_REGISTRY, getAllTools } from './tools/index.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker, CircuitState } from './circuit-breaker.js';
import { HealthServer } from './health-server.js';
import { ZodError } from 'zod';

// Configuration from environment variables
const ANALYSIS_API_URL = process.env.ANALYSIS_API_URL || 'http://localhost:8081';
const ACTIVITY_API_URL = process.env.ACTIVITY_API_URL || process.env.ANALYSIS_API_URL || 'http://localhost:8080';
const SESSION_ID = process.env.SESSION_ID || 'default-session';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_REQUESTS_PER_MINUTE = Number(process.env.MAX_REQUESTS_PER_MINUTE) || 60;
const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 8080;
const METABOB_API_KEY = process.env.METABOB_API_KEY;
const JWT_TOKEN = process.env.JWT_TOKEN;
const USE_CONNECTION_SLOTS = process.env.USE_CONNECTION_SLOTS === 'true';

// Initialize clients
const apiClient = new AnalysisAPIClient({
  baseURL: ANALYSIS_API_URL,
  activityApiUrl: ACTIVITY_API_URL,
  timeout: 30000,
  retryAttempts: 3,
  retryDelayMs: 100,
  apiKey: METABOB_API_KEY,
  jwtToken: JWT_TOKEN,
  useConnectionSlots: USE_CONNECTION_SLOTS,
  onConnectionStateChange: (state) => {
    log('info', `Connection state changed: ${state}`);
  },
});

const sessionManager = new SessionManager({
  timeoutMs: 3600000, // 1 hour
  cleanupIntervalMs: 300000, // 5 minutes
});

const rateLimiter = new RateLimiter({
  requestsPerMinute: MAX_REQUESTS_PER_MINUTE,
  windowMs: 60000,
});

const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 60000,
});

const healthServer = new HealthServer({
  port: HEALTH_PORT,
  apiClient,
  circuitBreaker,
});

// Create MCP server
const server = new Server(
  {
    name: 'metabob-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Log function
function log(level: string, message: string, data?: any) {
  if (LOG_LEVEL === 'debug' || (LOG_LEVEL === 'info' && level !== 'debug')) {
    const timestamp = new Date().toISOString();
    const logData = data ? ` ${JSON.stringify(data)}` : '';
    console.error(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
  }
}

/**
 * List all available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('debug', 'Listing tools');

  const tools = getAllTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  log('info', `Registered ${tools.length} tools`);

  return { tools };
});

/**
 * Handle tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log('info', `Tool call: ${name}`, { args });

  const startTime = Date.now();
  let success = false;

  try {
    // Check rate limit
    const rateLimitAllowed = await rateLimiter.checkLimit(SESSION_ID);
    if (!rateLimitAllowed) {
      const resetTime = rateLimiter.getResetTime(SESSION_ID);
      throw new McpError(
        ErrorCode.InternalError,
        `Rate limit exceeded: ${MAX_REQUESTS_PER_MINUTE} requests per minute. Try again in ${Math.ceil(resetTime / 1000)}s.`,
        {
          code: 'RATE_LIMIT_EXCEEDED',
          resetTimeMs: resetTime,
          limit: MAX_REQUESTS_PER_MINUTE,
        }
      );
    }

    // Check circuit breaker
    if (!circuitBreaker.isAllowed()) {
      const resetTime = circuitBreaker.getResetTime();
      throw new McpError(
        ErrorCode.InternalError,
        `Analysis API is temporarily unavailable due to repeated failures. Circuit breaker is open. Try again in ${Math.ceil(resetTime / 1000)}s.`,
        {
          code: 'SERVICE_UNAVAILABLE',
          circuitState: circuitBreaker.getState(),
          resetTimeMs: resetTime,
        }
      );
    }

    // Get tool from registry
    const tool = TOOL_REGISTRY[name];

    if (!tool) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}. Available tools: ${Object.keys(TOOL_REGISTRY).join(', ')}`
      );
    }

    // Validate input
    let validatedInput;
    try {
      validatedInput = tool.validateInput(args || {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters for tool ${name}: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
        );
      }
      throw error;
    }

    // Execute tool
    const result = await tool.handler(validatedInput, apiClient, SESSION_ID);

    success = true;
    circuitBreaker.recordSuccess();

    // Track usage
    const duration = Date.now() - startTime;
    await sessionManager.trackUsage(SESSION_ID, name, duration, success);

    log('info', `Tool ${name} completed in ${duration}ms`);

    // Return MCP response
    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    await sessionManager.trackUsage(SESSION_ID, name, duration, success);

    // Record circuit breaker failure for API errors
    if (error && typeof error === 'object' && 'code' in error) {
      const errorObj = error as any;
      if (errorObj.code !== 'RATE_LIMIT_EXCEEDED') {
        circuitBreaker.recordFailure();
      }
    }

    log('error', `Tool ${name} failed after ${duration}ms`, { error });

    // Handle MCP errors
    if (error instanceof McpError) {
      throw error;
    }

    // Handle API client errors
    if (error && typeof error === 'object' && 'code' in error) {
      const mcpError = error as any;
      throw new McpError(
        ErrorCode.InternalError,
        mcpError.message,
        mcpError.details
      );
    }

    // Generic error
    const err = error as Error;
    throw new McpError(
      ErrorCode.InternalError,
      err.message || 'An unexpected error occurred'
    );
  }
});

/**
 * Start server
 */
async function main() {
  // Determine auth method
  const authMethod = METABOB_API_KEY ? 'api_key' : JWT_TOKEN ? 'jwt' : 'none';

  log('info', 'Starting metabob-mcp server', {
    analysisAPIURL: ANALYSIS_API_URL,
    activityAPIURL: ACTIVITY_API_URL,
    sessionId: SESSION_ID,
    logLevel: LOG_LEVEL,
    auth: authMethod,
    connectionSlots: USE_CONNECTION_SLOTS,
  });

  // Start health check server
  try {
    await healthServer.start();
  } catch (error) {
    log('warn', 'Failed to start health server', { error });
  }

  // Authenticate with API key if provided
  if (METABOB_API_KEY) {
    try {
      log('info', 'Authenticating with API key...');
      const authResponse = await apiClient.authenticateWithApiKey();
      log('info', 'Authentication successful', {
        org_id: authResponse.org_id,
        user_id: authResponse.user_id,
        scopes: authResponse.scopes,
        expires_in: authResponse.expires_in,
      });
    } catch (error) {
      const err = error as Error;
      log('error', 'API key authentication failed', { error: err.message });
      console.error(`\nAuthentication failed: ${err.message}`);
      console.error('Check that your API key is valid and not expired.');
      console.error('Get a new API key from: https://app.metabob.com/settings/api-keys\n');
      process.exit(1);
    }
  } else if (!JWT_TOKEN) {
    log('warn', 'No authentication configured. Some features may be unavailable.');
    log('warn', 'Set METABOB_API_KEY or use --api-key for authenticated access.');
  }

  // Check API health (optional, non-blocking)
  try {
    await apiClient.health();
    log('info', 'Analysis API health check passed');
  } catch (error) {
    log('warn', 'Analysis API health check failed (continuing anyway)', { error });
  }

  // Acquire connection slot if enabled
  if (USE_CONNECTION_SLOTS) {
    try {
      log('info', 'Acquiring connection slot...');
      const connectionInfo = await apiClient.connectWithSlot();
      if (connectionInfo) {
        log('info', 'Connection slot acquired', {
          connectionId: connectionInfo.connectionId,
          slotNumber: connectionInfo.slotNumber,
          maxSlots: connectionInfo.maxSlots,
          gracePeriodMs: connectionInfo.gracePeriodMs,
        });
      }
    } catch (error) {
      const err = error as Error;
      log('error', 'Failed to acquire connection slot', { error: err.message });
      // Continue without connection slot - tools will still work but may be rate limited
      log('warn', 'Continuing without connection slot. Some features may be limited.');
    }
  }

  // Create transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'MCP server ready');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    log('info', 'Shutting down...');
    await apiClient.shutdown();
    await healthServer.stop();
    sessionManager.stop();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('info', 'Shutting down...');
    await apiClient.shutdown();
    await healthServer.stop();
    sessionManager.stop();
    await server.close();
    process.exit(0);
  });
}

// Run server
main().catch((error) => {
  log('error', 'Fatal error', { error });
  process.exit(1);
});
