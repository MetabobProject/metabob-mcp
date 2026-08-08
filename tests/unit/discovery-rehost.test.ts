import { expect, test } from 'bun:test';

import { buildResolverUrl, deriveLocalDiscoveryEndpoint } from '../../src/discovery.js';

/**
 * A loopback address handed back by a REMOTE registry is the dangerous case.
 *
 * The hub advertises goal-host as public_endpoint http://127.0.0.1:18210 and
 * resolve_endpoint http://127.0.0.1:8210/resolve. Both are correct only for a
 * client running on the substrate host. An operator workstation that runs its own
 * substrate publishes 18210 as well — so taking the advertisement verbatim does not
 * 404, it silently dispatches to the LOCAL substrate while the operator believes
 * they are driving the hub. Goals land, traces are written, verdicts return, and
 * nothing about the result looks wrong.
 */

const HUB_DISCOVERY = 'http://syzygy.host:18100';
const LOCAL_DISCOVERY = 'http://localhost:18100';

// Exactly what the hub returned for shape "goal_execution".
const HUB_GOAL_HOST = {
  vesselId: 'goal-host-vessel',
  shape: 'goal_execution',
  endpoint: 'http://127.0.0.1:8210',
  public_endpoint: 'http://127.0.0.1:18210',
  resolve_endpoint: 'http://127.0.0.1:8210/resolve',
};

test('a loopback public_endpoint from a remote registry is rehosted, not trusted', () => {
  const url = buildResolverUrl(HUB_GOAL_HOST, HUB_DISCOVERY);
  expect(new URL(url).hostname).toBe('syzygy.host');
  // The misroute this exists to prevent: never the caller's own machine.
  expect(url).not.toContain('127.0.0.1');
  expect(url).not.toContain('localhost');
});

test('the rehosted resolver keeps the PUBLISHED port, not the internal one', () => {
  // resolve_endpoint advertises :8210 (container-internal, unpublished on the hub).
  // Rehosting that verbatim yields syzygy.host:8210 — reachable-looking and dead.
  const url = new URL(buildResolverUrl(HUB_GOAL_HOST, HUB_DISCOVERY));
  expect(url.port).toBe('18210');
  expect(url.pathname).toBe('/resolve');
});

test('a genuinely local substrate is left alone', () => {
  // Discovery itself is loopback, so we ARE on the substrate host and the
  // advertisement means what it says. Rewriting here would break the local case.
  // The pre-existing legacy normalization still applies here (127.0.0.1 -> the
  // discovery hostname, internal 8210 -> host-mapped 18210); what matters is that
  // the target stays on this machine and is never sent to a remote host.
  const url = new URL(buildResolverUrl(HUB_GOAL_HOST, LOCAL_DISCOVERY));
  expect(['localhost', '127.0.0.1']).toContain(url.hostname);
  expect(url.port).toBe('18210');
});

test('a non-loopback advertisement is never rewritten', () => {
  // A vessel that advertises a real reachable host knows better than we do.
  const url = buildResolverUrl(
    { ...HUB_GOAL_HOST, public_endpoint: 'http://vessel.example.com:18210', resolve_endpoint: '/resolve' },
    HUB_DISCOVERY,
  );
  expect(new URL(url).hostname).toBe('vessel.example.com');
});

test('remote port-published substrates derive discovery from the port block', () => {
  expect(deriveLocalDiscoveryEndpoint('http://syzygy.host:18080')).toBe('http://syzygy.host:18100');
  expect(deriveLocalDiscoveryEndpoint('http://localhost:18080')).toBe('http://localhost:18100');
  // A portless proxy host must still fall through to the path-prefix branch.
  expect(deriveLocalDiscoveryEndpoint('http://ide.metabob.com')).toBeUndefined();
  // https:// is the reverse-proxy shape, never port-published.
  expect(deriveLocalDiscoveryEndpoint('https://ide.metabob.com')).toBeUndefined();
});
