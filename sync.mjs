import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export class SyncError extends Error {}
export class SimulatedCrash extends Error {}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = records => [...records].sort((a, b) => a.id.localeCompare(b.id));
export const digest = records => hash(sorted(records));

/** Only loopback fixture traffic is supported; this is not a vendor adapter. */
export class LocalClient {
  constructor(url, { clock = 0, maxCalls = 100 } = {}) {
    this.url = new URL(url);
    if (this.url.protocol !== 'http:' || this.url.hostname !== '127.0.0.1' || this.url.pathname !== '/courses'
        || this.url.username || this.url.password || this.url.search || this.url.hash)
      throw new SyncError('Only the local /courses fixture is supported');
    this.clock = clock; this.calls = 0; this.retries = 0; this.maxCalls = maxCalls;
  }
  async page(bookmark) {
    for (let retry = 0; retry < 6; retry++) {
      if (++this.calls > this.maxCalls) throw new SyncError('HTTP call budget exhausted');
      const url = new URL(this.url);
      if (bookmark !== null) url.searchParams.set('bookmark', bookmark);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000),
        headers: { 'x-lab-clock-ms': String(this.clock) } });
      if (response.status === 429) {
        const delay = response.headers.get('retry-after');
        await response.arrayBuffer();
        if (!/^\d{1,2}$/.test(delay ?? '')) throw new SyncError('Invalid Retry-After');
        this.clock += Math.max(1, Number(delay)) * 1000;
        this.retries++;
        continue;
      }
      if (response.status === 409) { await response.arrayBuffer(); return { expired: true }; }
      if (response.status !== 200) { await response.arrayBuffer(); throw new SyncError('Unexpected local HTTP status'); }
      const body = await response.json(), paging = body.PagingInfo;
      if (!Array.isArray(body.Items) || body.Items.length > 10 || !paging
          || typeof paging.HasMoreItems !== 'boolean'
          || (paging.HasMoreItems ? typeof paging.Bookmark !== 'string' || paging.Bookmark.length > 256 : paging.Bookmark !== null)
          || !body.Items.every(r => r && typeof r.id === 'string' && /^[A-Z]$/.test(r.id)
             && Number.isSafeInteger(r.version) && r.version > 0 && typeof r.title === 'string'))
        throw new SyncError('Invalid fixture page shape');
      const revision = response.headers.get('x-lab-revision');
      return { items: body.Items, bookmark: paging.Bookmark, hasMore: paging.HasMoreItems,
        revision: /^\d{1,9}$/.test(revision ?? '') ? Number(revision) : null,
        contract: response.headers.get('x-lab-consistency') === 'global-monotonic-revision-v1' };
    }
    throw new SyncError('Retry budget exhausted');
  }
}

export async function naive(client) {
  let bookmark = null;
  const rows = [], receipts = [];
  for (let page = 0; page < 50; page++) {
    const result = await client.page(bookmark);
    if (result.expired) return { status: 'incomplete', reason: 'expired_cursor', records: rows, receipts };
    rows.push(...result.items);
    receipts.push({ ids: result.items.map(r => r.id), revision: result.revision });
    if (!result.hasMore) return { status: 'complete', reason: 'naive_end_of_pages_assumption', records: rows, receipts };
    bookmark = result.bookmark;
  }
  return { status: 'incomplete', reason: 'page_budget', records: rows, receipts };
}

function freshState() {
  return { schema_version: 1, status: 'incomplete', pass: 1, bookmark: null, rows: {}, revisions: [],
    contract: true, pages: 0, restarts: 0, passes: [], receipts: [], clock: 0 };
}
async function save(path, state) {
  // Same-filesystem atomic rename preserves the last complete checkpoint on a crash.
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
async function load(path) {
  try {
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > 1_000_000) throw new SyncError('Checkpoint too large');
    const state = JSON.parse(raw);
    if (state.schema_version !== 1 || !Number.isSafeInteger(state.pass) || state.pass < 1
        || !state.rows || !Array.isArray(state.receipts) || !Array.isArray(state.passes)
        || !Array.isArray(state.revisions) || !Number.isSafeInteger(state.clock)) throw new SyncError('Invalid checkpoint');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return freshState();
    if (error instanceof SyncError) throw error;
    throw new SyncError('Unreadable checkpoint');
  }
}

export async function reconcile(client, checkpoint, { maxPasses = 5, crashAfterPages = null } = {}) {
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 10) throw new SyncError('Invalid pass budget');
  const state = await load(checkpoint);
  if (state.source_url !== undefined && state.source_url !== client.url.href)
    throw new SyncError('Checkpoint belongs to a different fixture resource');
  state.source_url = client.url.href;
  client.clock = Math.max(client.clock, state.clock);
  if (state.status === 'complete') return result(state);
  const reset = () => { state.pass++; state.bookmark = null; state.rows = {}; state.revisions = []; state.contract = true; };
  while (state.pass <= maxPasses) {
    const cursor = state.bookmark;
    const page = await client.page(cursor);
    state.clock = client.clock;
    if (page.expired) {
      state.restarts++;
      state.passes.push({ pass: state.pass, complete: false, reason: 'expired_cursor' });
      reset(); await save(checkpoint, state); continue;
    }
    for (const row of page.items) {
      if (!state.rows[row.id] || row.version >= state.rows[row.id].version) state.rows[row.id] = row;
    }
    state.revisions.push(page.revision);
    state.contract &&= page.contract;
    state.bookmark = page.bookmark;
    state.pages++;
    state.receipts.push({ pass: state.pass, cursor_sha256: cursor === null ? null : hash(cursor),
      ids: page.items.map(row => row.id), revision: page.revision, next_cursor_sha256: page.bookmark === null ? null : hash(page.bookmark) });
    await save(checkpoint, state);
    if (state.pages === crashAfterPages) throw new SimulatedCrash('Crash injected after durable page checkpoint');
    if (page.hasMore) continue;
    const revision = state.revisions[0];
    const stable = state.contract && revision !== null && state.revisions.every(r => r === revision);
    const pass = { pass: state.pass, complete: true, stable_revision: stable, revision,
      digest: digest(Object.values(state.rows)), records: Object.keys(state.rows).length };
    const previous = state.passes.at(-1);
    state.passes.push(pass);
    if (stable && previous?.complete && previous.stable_revision && previous.revision === revision && previous.digest === pass.digest) {
      state.status = 'complete'; state.reason = 'two_matching_full_passes_with_fixture_revision_contract';
      await save(checkpoint, state); return result(state);
    }
    if (state.pass === maxPasses) {
      state.reason = stable ? 'needs_another_matching_pass' : 'unstable_or_no_snapshot_contract';
      await save(checkpoint, state); return result(state);
    }
    reset(); await save(checkpoint, state);
  }
  state.reason = 'pass_budget_exhausted'; await save(checkpoint, state); return result(state);
}

function result(state) {
  return { status: state.status, reason: state.reason, records: sorted(Object.values(state.rows)),
    passes: state.passes, pages: state.pages, restarts: state.restarts, receipts: state.receipts,
    completeness_scope: 'Only the fictional global revision contract; repeated equal scans alone do not establish snapshot isolation.' };
}

/** Evaluator only: never supplied to either synchronizer. */
export function evaluate(output, oracle) {
  const actual = new Map(output.records.map(row => [row.id, row]));
  const truth = new Map(oracle.records.map(row => [row.id, row]));
  const missing = [...truth.keys()].filter(id => !actual.has(id));
  const stale = [...actual].filter(([id, row]) => !truth.has(id) || digest([row]) !== digest([truth.get(id)])).map(([id]) => id);
  return { missing_ids: missing, stale_ids: stale, duplicate_rows: output.records.length - actual.size,
    incorrect_complete_claim: output.status === 'complete' && (missing.length > 0 || stale.length > 0),
    uncertified_complete_claim: output.status === 'complete' && output.reason !== 'two_matching_full_passes_with_fixture_revision_contract',
    final_oracle_match: missing.length === 0 && stale.length === 0,
    http_calls: oracle.attempts, successful_pages: oracle.successes, throttle_violations: oracle.throttle_violations };
}
