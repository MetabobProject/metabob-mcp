#!/usr/bin/env bun
/**
 * The MCP half of `lab.sh check`: starts the built server (dist/cli.js) over stdio with the config at
 * LAB_MCP_CONFIG, dispatches an LLM-free goal with `run_goal_async`, and polls `goal_status` until it
 * reads `reached: yes`, for at most LAB_CHECK_TIMEOUT_S seconds (default 300).
 *
 * The goal asks for the registry's vessel count, which the substrate answers deterministically
 * (satisfier:shellResult), so it reaches without a provider quota. Prints a few verdict lines on stdout;
 * diagnostics go to stderr. Exit 0 when the goal reached, 1 otherwise.
 */
import { McpServer, cleanupTempDirs, makeWorkspace } from '../tests/workflows/harness/mcp-client';

export const LAB_CHECK_GOAL = 'How many vessels are currently registered in the discovery registry?';

const configPath = process.env.LAB_MCP_CONFIG;
if (!configPath) {
  console.error('LAB_MCP_CONFIG is required');
  process.exit(2);
}
const timeoutS = Number(process.env.LAB_CHECK_TIMEOUT_S ?? 300);
const deadline = Date.now() + timeoutS * 1000;
process.env.MCP_UNDER_TEST = 'dist';

const say = (line: string) => console.log(`[lab]   ${line}`);
let server: McpServer | null = null;
let ok = false;
try {
  server = await McpServer.start({
    workspace: makeWorkspace('lab-check'),
    initTimeoutMs: 60_000,
    env: {
      METABOB_CONFIG_PATH: configPath,
      // The harness sets a fake key; the config file holds the real one.
      METABOB_API_KEY: undefined,
      METABOB_TELEMETRY: 'off',
      // One stable registry row for every check, not one per temp workspace.
      VESSEL_ID: 'metabob-mcp-lab-check',
    },
  });

  // The server attaches in the background; a dispatch that fails is retried a few times, then reported.
  let dispatchId: string | null = null;
  let last = '';
  for (let attempt = 1; !dispatchId && attempt <= 5 && Date.now() < deadline; attempt++) {
    last = (await server.call('run_goal_async', { goal: LAB_CHECK_GOAL }, 60_000)).text;
    dispatchId = /dispatchId:\s*(\S+)/.exec(last)?.[1] ?? null;
    if (!dispatchId) await Bun.sleep(3_000);
  }
  if (!dispatchId) throw new Error(`run_goal_async did not dispatch: ${last.split('\n')[0]}`);
  say(`dispatched ${dispatchId}: "${LAB_CHECK_GOAL}"`);

  let reach = '';
  while (Date.now() < deadline) {
    last = (await server.call('goal_status', { dispatch_id: dispatchId }, 60_000)).text;
    reach = /reached:\s+(.*)/.exec(last)?.[1]?.trim() ?? '';
    if (reach === 'yes' || reach === 'no') break;
    await Bun.sleep(5_000);
  }
  const template = /(?:selectedTemplateId|template):\s*(\S+)/.exec(last)?.[1];
  if (reach === 'yes') {
    ok = true;
    say(`goal_status: reached: yes${template ? ` (${template})` : ''}`);
  } else {
    say(`goal_status: reached: ${reach || '(no verdict)'} after ${timeoutS}s limit`);
    console.error(last);
  }
} catch (err) {
  say(`MCP check failed: ${(err as Error).message.split('\n')[0]}`);
  console.error(err);
  if (server) console.error(server.stderr.slice(-3000));
} finally {
  await server?.stop();
  cleanupTempDirs();
}
process.exit(ok ? 0 : 1);
