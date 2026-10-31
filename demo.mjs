import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './fixture.mjs';
import { LocalClient, naive, reconcile, evaluate, SimulatedCrash } from './sync.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'coursesync-demo-'));
const experiments = [];
try {
  for (const scenario of ['stable', 'shift', 'deleted-cursor', 'churn', 'no-contract']) {
    const policies = [];
    for (const policy of ['naive', 'checkpoint-reconcile']) {
      const fixture = await startFixture({ scenario });
      try {
        let client = new LocalClient(fixture.url), output, crashed = false;
        if (policy === 'naive') output = await naive(client);
        else {
          const checkpoint = path.join(temporary, `${scenario}.json`);
          try { output = await reconcile(client, checkpoint, { crashAfterPages: 1 }); }
          catch (error) { if (!(error instanceof SimulatedCrash)) throw error; crashed = true; }
          // New client and reloaded file: no in-memory sync state crosses the restart.
          client = new LocalClient(fixture.url);
          output = await reconcile(client, checkpoint);
        }
        const oracle = fixture.oracle();
        policies.push({ policy, crash_recovered: crashed, status: output.status, reason: output.reason,
          record_ids: output.records.map(r => r.id), passes: output.passes ?? null,
          evaluation: evaluate(output, oracle), mutation_log: oracle.mutations });
      } finally { await fixture.close(); }
    }
    experiments.push({ scenario, policies });
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log(JSON.stringify({ provenance: 'real_loopback_HTTP_and_file_checkpoint_synthetic_courses_and_mutations',
  throttle_clock: 'deterministic_simulated_ms_not_real_wait_or_performance_measurement',
  compatibility: 'not_a_Brightspace_adapter_or_vendor_snapshot_guarantee', experiments }, null, 2));
