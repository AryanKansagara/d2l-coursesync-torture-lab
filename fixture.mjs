import http from 'node:http';
import { createHash } from 'node:crypto';

export async function startFixture({ scenario = 'shift', throttleEvery = 4, overlap = false, empty = false } = {}) {
  if (!['stable', 'shift', 'deleted-cursor', 'churn', 'no-contract'].includes(scenario)) throw new Error('Unknown scenario');
  let records = empty ? [] : 'ABCDEF'.split('').map(id => ({ id, version: 1, changedAt: 'same-timestamp', title: `Course ${id}` }));
  let revision = 1, successes = 0, attempts = 0, serial = 0, blockedUntil = 0, violations = 0;
  const cursors = new Map(), mutations = [], receipts = [];
  const server = http.createServer((req, res) => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/courses') return send(404, { error: 'fixture_route_only' });
    const clock = Number(req.headers['x-lab-clock-ms']);
    if (!Number.isSafeInteger(clock) || clock < 0) return send(400, { error: 'invalid_lab_clock' });
    attempts++;
    if (clock < blockedUntil) {
      violations++;
      return send(429, { error: 'retry_before_deadline' }, { 'retry-after': '1' });
    }
    if (throttleEvery && attempts % throttleEvery === 0) {
      blockedUntil = clock + 1000;
      return send(429, { error: 'fixture_throttled' }, { 'retry-after': '1' });
    }
    const bookmark = url.searchParams.get('bookmark');
    let offset = 0;
    if (bookmark !== null) {
      const cursor = cursors.get(bookmark);
      if (!cursor || !records.some(row => row.id === cursor.anchor)) return send(409, { error: 'bookmark_target_deleted' });
      offset = cursor.offset;
    }
    const items = structuredClone(records.slice(offset, offset + 2));
    const nextOffset = offset + (overlap ? 1 : 2);
    const hasMore = items.length > 0 && offset + 2 < records.length;
    let next = null;
    if (hasMore) {
      // Client must treat these bytes as opaque; no row ID or offset is exposed.
      next = createHash('sha256').update(`fixture-cursor:${++serial}:${offset}`).digest('hex');
      cursors.set(next, { offset: nextOffset, anchor: items.at(-1).id });
    }
    const headers = scenario === 'no-contract' ? {} : {
      'x-lab-revision': String(revision), 'x-lab-consistency': 'global-monotonic-revision-v1' };
    receipts.push({ successful_page: ++successes, revision, ids: items.map(r => r.id), has_more: hasMore });
    send(200, { Items: items, PagingInfo: { Bookmark: next, HasMoreItems: hasMore } }, headers);
    // Mutation occurs after response data has been snapshotted: later pages see a different view.
    if (successes === 1 && records.length && ['shift', 'deleted-cursor'].includes(scenario)) {
      const deleted = scenario === 'shift' ? 'A' : 'B';
      records = records.filter(row => row.id !== deleted);
      records.push({ id: 'G', version: 1, changedAt: 'same-timestamp', title: 'Course G' });
      revision++;
      mutations.push({ after_page: successes, deleted, inserted: 'G', revision });
    } else if (scenario === 'churn' && records.length) {
      records[0] = { ...records[0], version: records[0].version + 1 };
      revision++;
      mutations.push({ after_page: successes, updated: records[0].id, revision });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/courses`,
    oracle: () => structuredClone({ records, revision, attempts, successes, throttle_violations: violations, mutations, receipts }),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
