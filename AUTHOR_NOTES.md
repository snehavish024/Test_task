# Author Notes — Firmware Release Publisher

## Design

This task evaluates a Node.js publisher that integrates SQL reconciliation,
cryptographic signing, an HTTP service, and durable idempotency. The candidate
implements `/app/publisher/release-publisher.mjs`; the supplied Express gateway
is intentionally complete and is treated as an external service.

The manifest contains exact duplicate records, individual withdrawals, and a
fully withdrawn bundle. A correct solution must load the data into DuckDB and
derive the release set with SQL rather than treating the CSV as already clean.
The expected publishable bundles are derived again by the verifier from the raw
CSV, so hardcoded bundle counts or output cannot pass the persistence checks.

The gateway verifies detached CMS signatures against only the current certificate.
The rotated-out keypair remains available to make the trust-boundary failure
concrete. The verifier also performs its own revoked-key request and requires
the gateway to return `UNTRUSTED_SIGNATURE`, protecting against verification
bypasses or an altered gateway.

The publisher must sign a canonical JSON string, not a separately serialized
object. This makes the signed bytes, sent bytes, and verified bytes identical.
The local DuckDB `publications` table holds the token, receipt, status, key id,
and descriptor. The second run must produce identical stdout and leave the
gateway ledger unchanged.

## Traps and fairness

- Exact duplicates are identical across all eight columns, which is explicitly
  stated in the brief.
- Withdrawals apply by `supersedes_id` to the build `entry_id`; fully withdrawn
  bundles are excluded.
- The old signing key is real but cannot verify against the gateway's current
  trust root.
- CMS signatures are over a whitespace-free, lexicographically sorted JSON
  string. This byte-level condition is described in the instruction.
- Receipt IDs are random and therefore masked in the golden-output assertion;
  the tests check their persisted behavior instead of hardcoding them.
- The solver cannot read or modify the gateway ledger; only the verifier checks
  it to establish idempotency.

## Verification

```sh
cd environment && docker build -t firmware-release-publisher-task .
cd ..
docker run --rm -v "$PWD/tests":/tests:ro firmware-release-publisher-task \
  bash -lc 'bash /tests/test.sh; cat /logs/verifier/reward.txt'
docker run --rm -v "$PWD/tests":/tests:ro -v "$PWD/solution":/solution:ro \
  firmware-release-publisher-task \
  bash -lc 'bash /solution/publish.sh && bash /tests/test.sh; cat /logs/verifier/reward.txt'
```

The expected results are 0 for the empty image and 1 after the reference
solution is installed. Clean-container verification was run on 2026-08-17.

- Proof A (empty): reward `0` (the publisher module is absent and the grader
  fails as expected).
- Proof B (reference solution): reward `1` (all four verifier checks passed).
