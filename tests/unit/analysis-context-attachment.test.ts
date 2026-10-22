/**
 * get_analysis_context opens with where this session writes and as whom (SPEC §get_analysis_context): agents writing
 * to the shared ledger had no read that showed their org, endpoint or vesselId.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { setAttachment } from '../../src/attachment';
import { setResolverIdentity } from '../../src/resolver-identity';
import { attachmentLines } from '../../src/tools/get-analysis-context';
import { installShapeStub, STUB_DISCOVERY } from '../helpers/shape-stub';

beforeAll(() => setResolverIdentity({ vesselId: 'metabob-mcp-ctx' }));
afterAll(() => setResolverIdentity({ vesselId: undefined }));
afterEach(() => setAttachment(null));

test('attached: the org, the discovery endpoint and this session\'s identity; never the key', async () => {
  await installShapeStub({});
  const lines = await attachmentLines('sess-1');
  expect(lines[0]).toBe(`Attachment: attached to org org_stub via discovery ${STUB_DISCOVERY}`);
  expect(lines[1]).toContain('as:         metabob-mcp-ctx (session sess-1)');
  expect(lines.join('\n')).not.toContain('mb_stub_key');
});

test('not attached: says so', async () => {
  setAttachment(null);
  expect((await attachmentLines('sess-2'))[0]).toStartWith('Attachment: not attached');
});
