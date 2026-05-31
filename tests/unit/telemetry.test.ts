/**
 * Telemetry module tests — covers the kill switch + basic record/flush.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { Telemetry } from '../../src/telemetry';

const ORIGINAL_TELEMETRY_ENV = process.env.METABOB_TELEMETRY;

afterEach(() => {
  if (ORIGINAL_TELEMETRY_ENV === undefined) {
    delete process.env.METABOB_TELEMETRY;
  } else {
    process.env.METABOB_TELEMETRY = ORIGINAL_TELEMETRY_ENV;
  }
});

test('kill switch: METABOB_TELEMETRY=off disables emission', () => {
  process.env.METABOB_TELEMETRY = 'off';
  let fetched = 0;
  const fetchImpl: typeof fetch = async () => {
    fetched += 1;
    return new Response(null, { status: 204 });
  };
  const t = new Telemetry({
    apiKey: 'test-key',
    mcpVersion: '0.0.0-test',
    endpoint: 'http://test',
    fetchImpl,
  });
  expect(t.isDisabled()).toBe(true);
  t.record({ tool_name: 'init_workspace', success: true });
  expect(fetched).toBe(0);
  expect(t.bufferSize()).toBe(0);
});

test('kill switch: missing apiKey disables emission', () => {
  delete process.env.METABOB_TELEMETRY;
  let fetched = 0;
  const t = new Telemetry({
    apiKey: undefined,
    mcpVersion: '0.0.0-test',
    endpoint: 'http://test',
    fetchImpl: async () => {
      fetched += 1;
      return new Response(null, { status: 204 });
    },
  });
  expect(t.isDisabled()).toBe(true);
  t.record({ tool_name: 'x', success: true });
  expect(fetched).toBe(0);
});

test('enabled: record() triggers async POST with Bearer auth', async () => {
  delete process.env.METABOB_TELEMETRY;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  const t = new Telemetry({
    apiKey: 'raw-key',
    mcpVersion: '0.2.6-test',
    endpoint: 'http://user.test',
    fetchImpl,
  });
  expect(t.isDisabled()).toBe(false);
  t.record({ tool_name: 'init_workspace', success: true, duration_ms: 42 });
  // Wait a tick for the fire-and-forget flush.
  await new Promise((r) => setTimeout(r, 10));
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe('http://user.test/v2/mcp/usage');
  const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
  // Bearer-first per 2026-05 auth header migration; falls back to ApiKey on 401.
  expect(headers?.Authorization).toBe('Bearer raw-key');
  const body = JSON.parse(String(calls[0]!.init?.body));
  expect(body.tool_name).toBe('init_workspace');
  expect(body.success).toBe(true);
  expect(body.mcp_version).toBe('0.2.6-test');
});
