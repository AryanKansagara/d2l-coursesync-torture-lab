# CourseSync Torture Lab

D2L builds Brightspace, a learning-management platform with APIs and data exports. This independent project tests one integration risk: an end-of-pages response does not necessarily establish a complete snapshot while records change.

**Implemented:** a real loopback HTTP server, opaque server-side bookmarks, scripted mutations and 409 cursor expiry, 429 retries, atomic JSON checkpoints, restart, full-pass reconciliation and an evaluator. Courses, revision guarantees, mutation schedules and clock are fictional. This is **not a Brightspace adapter or compatibility certification**.

## Run

Node 22+; no packages, keys or external network.

```sh
npm test
node demo.mjs
node demo.mjs > demo.json
```

The demo starts a fresh HTTP fixture for each policy/scenario, injects a crash after the first checkpointed page, discards the client and reloads the file with a new client. It writes actual results as JSON. Nine tests exercise stable data, same timestamps, shifted pages, deleted cursor anchors, restart, throttling, perpetual mutation, absent snapshot guarantees, empty courses, overlapping pages, malformed checkpoints and bounds.

## Measured fixture outcomes

| Scenario | Naive result | Checkpoint/reconcile result | Robust HTTP calls |
| --- | --- | --- | ---: |
| Stable | Correct rows, uncertified end-of-pages claim | Complete, exact final fixture rows | 7 |
| Delete A / insert G after page 1 | Misses C, retains A, incorrectly claims complete | Complete, IDs B–G | 11 |
| Delete bookmark target B | Stops incomplete | Restarts, then complete | 10 |
| Change A after every page | Stale A, incorrectly claims complete | Explicitly incomplete after 5 passes | 19 |
| Stable rows, no snapshot contract | Correct rows, uncertified completeness claim | Exact rows but explicitly incomplete | 19 |

All ten policy runs record zero retry-deadline violations. The robust cases recover the injected restart. Counts are HTTP calls to the local fixture, not vendor latency or throughput benchmarks. Baseline and reconciler share the same HTTP/throttle helper; their difference is snapshot reasoning and reconciliation, not one policy ignoring 429s.

## Completeness contract

Each page in the fictional endpoint can advertise a global monotonic revision. Under this **local** contract, matching revisions throughout a full traversal establish a stable pass. Two consecutive full stable passes must also match revision and canonical ID/version/content digest. The second pass is a reconciliation check; equal digests by themselves never establish a certificate. If the revision contract is absent or changes indefinitely, the result stays incomplete even when rows happen to match the evaluator's oracle.

The client never parses bookmark bytes. It persists opaque cursors plus hashed page receipts, candidate rows, pass revisions and retry clock. An expired cursor restarts a full pass. New passes replace the candidate set, so deleted rows are removed rather than kept forever. IDs/versions deduplicate overlap; equal timestamps are not treated as a unique cursor. The evaluator alone reads the final fixture oracle and mutation log; neither sync policy receives it. Mutations are triggered by successful page reads, so endlessly changing runs have different final fixture revisions across policies; they are not same-time production snapshots.

## Boundaries

- `fixture.mjs` binds only `127.0.0.1`; `LocalClient` accepts only that local HTTP route, disables redirects and bounds request time, attempts and retries.
- `Retry-After: 1` advances a deterministic simulated clock used by the server; there is no actual one-second sleep or real-time rate-limit performance claim.
- Checkpoints are trusted, single-writer local files bound to the fixture URL. Temp-write plus same-filesystem rename protects against the injected process-level restart; it is not fsync-backed power-loss durability or a database transaction. The demo injects an exception, not an operating-system kill. Completed checkpoints describe that completed run; use a new checkpoint for a fresh sync.
- Default reconciliation permits 5 passes (maximum 10); each client has a 100-call budget, six-attempt retry budget and 2-second local request timeout. Calls exceeding budget fail explicitly.
- This milestone uses JSON files, **not SQLite**, OAuth, Data Hub, live Brightspace data or a browser UI. Node fits the HTTP and checkpoint orchestration; no inference engine needs C++ here.

## Sources and proposed gap

Checked October 31, 2026:

- https://docs.valence.desire2learn.com/basic/apicall.html — API versions, paging/bookmarks and rate limits. Retrieved documentation is labeled November 2026; tenant-supported endpoint versions must be checked for a live adapter.
- https://docs.valence.desire2learn.com/res/dataExport.html — paginated export resources.
- https://community.d2l.com/brightspace/kb/articles/1195-rate-limiting-and-api-response-headers — rate-limit headers and retry handling.

The project infers an integration-testing opportunity from these documented concerns. It does not infer any Brightspace global-revision guarantee, claim missing vendor functionality, or assert a confidential roadmap. Live read-only validation needs an approved test tenant, OAuth scopes, synthetic records and endpoint-specific contracts.
