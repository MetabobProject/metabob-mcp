/**
 * Attachment for the cell CLI steps (`task pull`, `finding close`): the configuration, the attachment and the
 * vessel identity, as the server sets them at boot (SPEC §task-pull). Returns the cause when it does not attach.
 */
import { randomUUID } from 'node:crypto';
import { attach, setAttachment } from './attachment.js';
import { applyConfiguration, discoveryEndpointSource, unattachedMessage } from './config.js';
import { resolveVesselId } from './vessel-identity.js';
import { setResolverIdentity } from './resolver-identity.js';

export async function attachForCli(workspaceRoot: string): Promise<{ ok: true; vesselId?: string; sessionId: string } | { ok: false; cause: string }> {
  const { warnings } = applyConfiguration(process.env);
  for (const w of warnings) process.stderr.write(`warn: ${w}\n`);
  const missing = unattachedMessage(process.env);
  if (missing) return { ok: false, cause: missing };
  const attachment = attach({
    discovery: process.env.DISCOVERY_ENDPOINT!,
    discoverySource: discoveryEndpointSource(process.env),
    key: process.env.METABOB_API_KEY!.trim(),
    identityOverride: process.env.IDENTITY_ENDPOINT,
    heartbeatMs: 0,
    env: process.env,
    log: (level, message) => { if (level !== 'debug') process.stderr.write(`${level}: ${message}\n`); },
  });
  const state = await attachment.settled();
  setAttachment(attachment);
  if (state.auth.status !== 'authenticated') return { ok: false, cause: `not attached: ${state.cause ?? state.auth.status}` };
  const vesselId = await resolveVesselId({ explicit: process.env.VESSEL_ID, apiKey: process.env.METABOB_API_KEY, workspaceRoot });
  setResolverIdentity({ vesselId });
  return { ok: true, vesselId, sessionId: process.env.SESSION_ID || randomUUID() };
}
