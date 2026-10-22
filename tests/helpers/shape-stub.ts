/**
 * A substrate reached the way the tools reach it: one discovery whose
 * `POST /resolve` dispatches on `pointer.type` to in-memory shape handlers, behind
 * a real, authenticated attachment (src/attachment.ts) installed as the process
 * attachment. Tool handlers driven directly in unit tests resolve through it, so
 * each test states the shapes a tool may use and asserts the pointers it sent.
 *
 * A shape with no handler answers as discovery does when nothing produces it:
 * `404 { error: "Not found", shape }`.
 */
import { attach, setAttachment, type Attachment } from '../../src/attachment';

export interface ShapeAnswer {
  status?: number;
  body: unknown;
}

export type ShapeHandler = (pointer: Record<string, any>) => ShapeAnswer | Promise<ShapeAnswer>;

export const STUB_DISCOVERY = 'http://discovery.stub';
const STUB_IDENTITY = 'http://identity.stub';
export const STUB_KEY = 'mb_stub_key';

export interface ShapeStub {
  attachment: Attachment;
  /** Every pointer resolved, in order. */
  pointers: Array<Record<string, any>>;
  /** Every URL fetched by the attachment (bootstrap, org check, resolves). */
  urls: string[];
  /** The pointers resolved for one shape, without the client_claim every write carries. */
  calls(shape: string): Array<Record<string, any>>;
  /** The client_claim each resolve of one shape carried (undefined for a read). */
  claims(shape: string): Array<Record<string, any> | undefined>;
  restore(): void;
}

export async function installShapeStub(
  handlers: Record<string, ShapeHandler>,
  opts: { discovery?: string; scopes?: string[] } = {},
): Promise<ShapeStub> {
  const discovery = opts.discovery ?? STUB_DISCOVERY;
  const pointers: Array<Record<string, any>> = [];
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init);
    urls.push(req.url);
    const url = new URL(req.url);
    if (url.origin === discovery && url.pathname === '/bootstrap') {
      return Response.json({ relay_multiaddrs: [], identity_endpoint: STUB_IDENTITY, discovery_endpoint: '', prefer_transport: 'libp2p' });
    }
    if (url.origin === STUB_IDENTITY && url.pathname === '/health') return Response.json({ status: 'ok' });
    if (url.origin === STUB_IDENTITY && url.pathname === '/v1/auth/resolve') {
      // With scopes, identity answers the nested form, which reports them; otherwise the flat form, which does not.
      return opts.scopes
        ? Response.json({ success: true, data: { orgId: 'org_stub', keyId: 'key_stub', scopes: opts.scopes } })
        : Response.json({ valid: true, org_id: 'org_stub', key_id: 'key_stub' });
    }
    if (url.origin === discovery && url.pathname === '/resolve') {
      const { pointer } = (await req.json()) as { pointer: Record<string, any> };
      pointers.push(pointer);
      const handler = handlers[String(pointer.type)];
      if (!handler) return Response.json({ error: 'Not found', shape: pointer.type }, { status: 404 });
      const answer = await handler(pointer);
      return Response.json(answer.body, { status: answer.status ?? 200 });
    }
    // Anything else (concept-db's usage history, which no shape serves) goes to
    // the global fetch, so a test can serve it or stub it.
    return globalThis.fetch(input, init);
  }) as typeof fetch;

  const attachment = attach({
    discovery,
    key: STUB_KEY,
    heartbeatMs: 0,
    log: () => {},
    fetchImpl,
    sleep: async () => {},
  });
  await attachment.settled();
  setAttachment(attachment);
  return {
    attachment,
    pointers,
    urls,
    calls: (shape) => pointers.filter((p) => p.type === shape).map(({ client_claim: _claim, ...rest }) => rest),
    claims: (shape) => pointers.filter((p) => p.type === shape).map((p) => p.client_claim),
    restore: () => setAttachment(null),
  };
}
