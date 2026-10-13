/**
 * Substrate routing context handed to every tool handler: the configured
 * discovery endpoint and the activity-api base. It makes no requests of its
 * own and sends no workspace file content; the substrate tools
 * locate their target vessel through discovery and call it directly
 * (SPEC §substrate-goal-tools, SPEC §concept-graph-tools).
 */

export interface APIClientConfig {
  /** Discovery-vessel base URL — the anchor the substrate tools resolve vessels through. */
  discoveryEndpoint?: string;
  /** Activity-api base URL (execution traces, oracle labels). */
  activityApiUrl?: string;
}

export class AnalysisAPIClient {
  private readonly discoveryEndpoint?: string;
  private readonly activityApiUrl?: string;

  constructor(config: APIClientConfig = {}) {
    this.discoveryEndpoint = config.discoveryEndpoint;
    this.activityApiUrl = config.activityApiUrl;
  }

  hasDiscovery(): boolean {
    return Boolean(this.discoveryEndpoint);
  }

  getDiscoveryEndpoint(): string | undefined {
    return this.discoveryEndpoint;
  }

  /** Activity-API base URL (trace store + learner), if configured. Used by
   *  goal_status to hydrate a finished dispatch's execution trace. */
  getActivityApiUrl(): string | undefined {
    return this.activityApiUrl;
  }
}
