import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startFixture } from './fixture.mjs';
import { LocalClient, reconcile, naive, evaluate, SimulatedCrash, SyncError } from './sync.mjs';

async function harness(options, run) {
  const fixture = await startFixture(options);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'coursesync-test-'));
  try { return await run(fixture, path.join(temporary, 'checkpoint.json')); }
  finally { await fixture.close(); await rm(temporary, { recursive: true, force: true }); }
}

test('stable scan converges with explicit fixture contract and equal timestamps', async () => {
  await harness({ scenario: 'stable' }, async (fixture, checkpoint) => {
    const result = await reconcile(new LocalClient(fixture.url), checkpoint);
    assert.equal(result.status, 'complete');
    assert.equal(result.passes.length, 2);
    assert.equal(result.records.length, 6);
    assert.deepEqual(new Set(result.records.map(r => r.changedAt)), new Set(['same-timestamp']));
    assert.equal(evaluate(result, fixture.oracle()).final_oracle_match, true);
  });
});
test('naive end-of-pages can miss shifted row and retain deletion', async () => {
  await harness({ scenario: 'shift' }, async fixture => {
    const result = await naive(new LocalClient(fixture.url));
    const evaluation = evaluate(result, fixture.oracle());
    assert.deepEqual(evaluation.missing_ids, ['C']);
    assert.deepEqual(evaluation.stale_ids, ['A']);
    assert.equal(evaluation.incorrect_complete_claim, true);
  });
});
test('durable page checkpoint resumes through mutation and reconciles deleted rows', async () => {
  await harness({ scenario: 'shift' }, async (fixture, checkpoint) => {
    await assert.rejects(reconcile(new LocalClient(fixture.url), checkpoint, { crashAfterPages: 1 }), SimulatedCrash);
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.equal(saved.pages, 1); assert.equal(typeof saved.bookmark, 'string');
    const result = await reconcile(new LocalClient(fixture.url), checkpoint);
    assert.equal(result.status, 'complete');
    assert.equal(result.passes[0].stable_revision, false);
    assert.deepEqual(result.records.map(r => r.id), ['B', 'C', 'D', 'E', 'F', 'G']);
    assert.equal(evaluate(result, fixture.oracle()).final_oracle_match, true);
  });
});
test('deleted opaque bookmark triggers restart rather than interpreting its bytes', async () => {
  await harness({ scenario: 'deleted-cursor' }, async (fixture, checkpoint) => {
    const result = await reconcile(new LocalClient(fixture.url), checkpoint);
    assert.equal(result.status, 'complete');
    assert.equal(result.restarts, 1);
    assert.equal(result.passes[0].reason, 'expired_cursor');
    assert.equal(evaluate(result, fixture.oracle()).final_oracle_match, true);
  });
});
test('429 retries honor deadline on injected deterministic clock over real HTTP', async () => {
  await harness({ scenario: 'stable', throttleEvery: 2 }, async (fixture, checkpoint) => {
    const client = new LocalClient(fixture.url);
    const result = await reconcile(client, checkpoint);
    assert.equal(result.status, 'complete'); assert.ok(client.retries >= 1);
    assert.ok(client.clock >= 1000); assert.equal(fixture.oracle().throttle_violations, 0);
  });
});
test('perpetual mutation never manufactures completeness', async () => {
  await harness({ scenario: 'churn' }, async (fixture, checkpoint) => {
    const result = await reconcile(new LocalClient(fixture.url), checkpoint, { maxPasses: 3 });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'unstable_or_no_snapshot_contract');
    assert.ok(result.passes.every(pass => !pass.stable_revision));
  });
});
test('equal digests without a snapshot contract are explicitly incomplete', async () => {
  await harness({ scenario: 'no-contract' }, async (fixture, checkpoint) => {
    const result = await reconcile(new LocalClient(fixture.url), checkpoint, { maxPasses: 3 });
    assert.equal(result.passes[0].digest, result.passes[1].digest);
    assert.equal(result.status, 'incomplete');
    assert.equal(evaluate(result, fixture.oracle()).final_oracle_match, true);
  });
});
test('empty course converges, overlapping pages deduplicate by ID/version', async () => {
  for (const options of [{ empty: true }, { overlap: true }]) {
    await harness({ scenario: 'stable', ...options }, async (fixture, checkpoint) => {
      const result = await reconcile(new LocalClient(fixture.url), checkpoint);
      assert.equal(result.status, 'complete');
      const evaluation = evaluate(result, fixture.oracle());
      assert.equal(evaluation.final_oracle_match, true); assert.equal(evaluation.duplicate_rows, 0);
    });
  }
});
test('corrupt checkpoint, call budgets, pass budgets and non-local URLs fail explicitly', async () => {
  assert.throws(() => new LocalClient('https://example.com/courses'), SyncError);
  await harness({ scenario: 'stable' }, async (fixture, checkpoint) => {
    await writeFile(checkpoint, '{');
    await assert.rejects(reconcile(new LocalClient(fixture.url), checkpoint), SyncError);
    await assert.rejects(naive(new LocalClient(fixture.url, { maxCalls: 1 })), /budget/);
    await assert.rejects(reconcile(new LocalClient(fixture.url), checkpoint, { maxPasses: 0 }), SyncError);
  });
});
