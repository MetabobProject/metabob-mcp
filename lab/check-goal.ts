#!/usr/bin/env bun
/**
 * The MCP half of `lab.sh check`: starts the built server (dist/cli.js) over stdio with the config at
 * LAB_MCP_CONFIG, asks an LLM-free goal with `run_goal_async`, and reads `goal_status` until the walk's
 * answer cites the ask, for at most LAB_CHECK_TIMEOUT_S seconds (default 300).
 *
 * The goal asks for the registry's vessel count, which the substrate answers without a provider quota.
 * Prints a few verdict lines on stdout; diagnostics go to stderr. Exit 0 when the ask was answered, 3 when
 * the goal tools wait on the cockpit's own operator sign-in (the lab key is not an operator's), 1 otherwise.
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

  // The server attaches in the background; an ask that fails is retried a few times, then reported.
  let dispatchId: string | null = null;
  let last = '';
  for (let attempt = 1; !dispatchId && attempt <= 5 && Date.now() < deadline; attempt++) {
    last = (await server.call('run_goal_async', { goal: LAB_CHECK_GOAL }, 60_000)).text;
    dispatchId = /dispatchId:\s*(\S+)/.exec(last)?.[1] ?? null;
    // The goal tools write nothing under a key identity does not mark operator: not a failure of the lab.
    if (!dispatchId && /waiting on the cockpit's own sign-in/.test(last)) {
      say(last.split('\n')[0]!);
      process.exit(3);
    }
    if (!dispatchId) await Bun.sleep(3_000);
  }
  if (!dispatchId) throw new Error(`run_goal_async did not record the ask: ${last.split('\n')[0]}`);
  say(`asked ${dispatchId}: "${LAB_CHECK_GOAL}"`);

  // Gentle polling, until an answer cites the ask.
  for (let poll = 0; Date.now() < deadline; poll++) {
    last = (await server.call('goal_status', { dispatch_id: dispatchId }, 60_000)).text;
    if (/^\s*answer \S+/m.test(last)) break;
    await Bun.sleep(Math.min(15_000, 5_000 * 2 ** Math.max(0, poll - 1)));
  }
  const answer = /^\s*(answer \S+.*)$/m.exec(last)?.[1];
  if (answer) {
    ok = true;
    say(`goal_status: ${answer.slice(0, 160)}`);
  } else {
    say(`goal_status: no answer after ${timeoutS}s limit`);
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
