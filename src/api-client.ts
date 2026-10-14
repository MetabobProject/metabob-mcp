/**
 * The context handed to every tool handler. It carries no substrate address
 * and makes no requests: substrate tools reach the substrate only through the
 * attachment's resolve() (src/attachment.ts), the one ingress
 * (SPEC §substrate-goal-tools, SPEC §concept-graph-tools).
 */
export class AnalysisAPIClient {}
