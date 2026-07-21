import { describe, expect, test } from 'bun:test';

import {
  overlayTargetOf,
  resolveViaBestTransport,
  withTimeout,
} from '../../src/federation/route-for';
import { fetchBootstrapAnchors } from '../../src/bootstrap';
import type { FederationNode } from '../../src/federation/libp2p-node';

function fakeNode(over: Partial<FederationNode> = {}): FederationNode {
  return {
    peerId: 'peer-x',
    currentCircuit: () => '/ip4/1.2.3.4/tcp/30333/p2p/relay/p2p-circuit/p2p/peer-x',
    resolveViaLibp2p: async () => ({ content: 'via-libp2p' }),
    resolveViaHttp: async () => ({ content: 'via-libp2p-http' }),
    stop: async () => {},
    ...over,
  };
}

describe('overlayTargetOf', () => {
  test('prefers a libp2p multiaddr', () => {
    expect(
      overlayTargetOf({ protocol: 'libp2p', libp2p_multiaddr: ['/ma/1'], libp2p_peer_id: 'p' }),
    ).toBe('/ma/1');
  });
  test('falls back to peerId when no multiaddr', () => {
    expect(overlayTargetOf({ protocol: 'libp2p', libp2p_peer_id: 'p' })).toBe('p');
  });
  test('undefined when not a libp2p row', () => {
    expect(overlayTargetOf({ protocol: 'http', libp2p_multiaddr: ['/ma/1'] })).toBeUndefined();
  });
  test('undefined when libp2p but no addressing at all', () => {
    expect(overlayTargetOf({ protocol: 'libp2p' })).toBeUndefined();
  });
});

describe('resolveViaBestTransport', () => {
  const cap = { protocol: 'libp2p', libp2p_multiaddr: ['/ma/1'], libp2p_peer_id: 'p' };

  test('no node → HTTP fallback (unchanged behavior)', async () => {
    let httpCalled = false;
    const out = await resolveViaBestTransport({
      capability: cap,
      pointer: {},
      node: null,
      httpFallback: async () => {
        httpCalled = true;
        return 'http';
      },
    });
    expect(httpCalled).toBe(true);
    expect(out).toBe('http');
  });

  test('node + libp2p target → prefers libp2p leg', async () => {
    const out = await resolveViaBestTransport({
      capability: cap,
      pointer: {},
      node: fakeNode(),
      httpFallback: async () => 'http',
    });
    expect(out).toEqual({ content: 'via-libp2p' });
  });

  test('libp2p leg fails → libp2p-http leg', async () => {
    const out = await resolveViaBestTransport({
      capability: cap,
      pointer: {},
      node: fakeNode({ resolveViaLibp2p: async () => { throw new Error('down'); } }),
      httpFallback: async () => 'http',
    });
    expect(out).toEqual({ content: 'via-libp2p-http' });
  });

  test('both overlay legs fail → HTTP fallback', async () => {
    const out = await resolveViaBestTransport({
      capability: cap,
      pointer: {},
      node: fakeNode({
        resolveViaLibp2p: async () => { throw new Error('down'); },
        resolveViaHttp: async () => { throw new Error('down'); },
      }),
      httpFallback: async () => 'http',
    });
    expect(out).toBe('http');
  });

  test('non-libp2p capability with a node → HTTP fallback', async () => {
    const out = await resolveViaBestTransport({
      capability: { protocol: 'http' },
      pointer: {},
      node: fakeNode(),
      httpFallback: async () => 'http',
    });
    expect(out).toBe('http');
  });
});

describe('withTimeout', () => {
  test('rejects when the promise outlasts the bound', async () => {
    await expect(
      withTimeout(new Promise((r) => setTimeout(r, 50)), 5, 'slow'),
    ).rejects.toThrow(/timed out/);
  });
  test('resolves a fast promise', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'fast')).resolves.toBe('ok');
  });
});

describe('fetchBootstrapAnchors', () => {
  test('undefined endpoint → empty anchors (LOCAL mode)', async () => {
    expect(await fetchBootstrapAnchors(undefined)).toEqual({ relayMultiaddrs: [] });
  });
  test('unreachable endpoint → empty anchors, never throws', async () => {
    const out = await fetchBootstrapAnchors('http://127.0.0.1:1/nope', 300);
    expect(out.relayMultiaddrs).toEqual([]);
  });
});
