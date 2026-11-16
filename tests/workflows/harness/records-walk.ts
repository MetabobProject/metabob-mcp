/**
 * A walk's rows for the fake records, taken from installed records' own read answers
 * (tests/fixtures/records-rows.json): the rows citing the ask (section 2), the walk's
 * selection on it (section 4) and its calls (section 6a, with 6b's output on the call it
 * read). Only the ask's id is changed, to the one the fake stored; every other field and
 * the structure are the fixture's.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordRow, SubstrateState } from './fake-substrate';

const FIXTURE = readFileSync(join(import.meta.dir, '../../fixtures/records-rows.json'), 'utf8');
const ASK_ID = (JSON.parse(FIXTURE)['1_record_read_shape_world_changed_ids'][0] as RecordRow).id;

/** The fixture with its ask's id replaced by `askId`. */
export function walkFor(askId: string) {
  const f = JSON.parse(FIXTURE.split(ASK_ID).join(askId));
  const citing = f['2_record_read_refs_to_ask__one_of_each_shape'] as RecordRow[];
  const selection = (f['4_record_read_selection_where_root'] as RecordRow[])[0]!;
  const read = (f['6b_record_read_call_id'] as Array<Record<string, unknown>>)[0]!;
  const calls = (f['6a_record_read_root_calls_all_output_false__first2'] as Array<Record<string, unknown>>)
    .map((c) => (c.call_id === read.call_id ? read : c));
  return {
    citing,
    selection,
    calls,
    answer: citing.find((r) => r.shape === 'answer')!,
    due: citing.find((r) => typeof r.within_ms === 'number' && typeof r.at === 'number')!,
    readCall: read,
  };
}

/** Seed the fake's records with the walk on `askId`: its rows, its selection and its calls. */
export function seedWalk(state: SubstrateState, askId: string) {
  const w = walkFor(askId);
  state.rows.push(...w.citing, w.selection);
  state.calls.push(...w.calls);
  return w;
}
