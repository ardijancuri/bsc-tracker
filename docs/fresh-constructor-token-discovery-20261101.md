# Constructor-created token discovery

Prepared for the user-requested v1.5 release on 1 November 2026, based on
deployed commit `fbbb259ad0b1737e7e0c7cef5b26268b6dee387d`.
Unrelated X automation work is excluded from this release.

## Problem and resulting behavior

CENSUS (`0xfc96737a40dbf169782e60539b82d4ee17f25708`) had captured
monitored-wallet receipts but remained outside the token directory and feeds.
Discovery was waiting for authenticated creation evidence. A PancakeSwap pool
or first observed trade cannot establish when the token itself was created.

Four shared defects prevented progress:

1. Production stores its immutable tracking-start timestamp with whole seconds.
   Discovery accepted only timestamps containing `.000`, so it could not use
   the authenticated checkpoint after the node pruned that old header.
2. Retrying an older receipt could overwrite a newer discovery reference when
   its block hash differed. The queue now keeps its latest block reference and
   associated wallet context, including when an old receipt reactivates a job.
3. The creation search jumped back through old pruned history. It now expands
   backwards from recorded activity, resumes from bounded saved observations,
   and narrows an adjacent empty-code/nonempty-code bracket. Reused headers
   still require canonical checks.
4. CENSUS was created inside another contract's constructor and emitted no mint
   log at birth. The resolver now supports that pattern through bounded complete
   constructor traces, after the adjacent code proof has already been found.

The worker can trace at most two top-level constructor candidates from a birth
block. Derived child addresses only prioritize candidates. Admission still
requires the original successful receipt, transaction position, complete trace
context, a successful CREATE/CREATE2 frame returning the exact authenticated
runtime, canonical adjacent headers and the original tracking boundary.

The existing server-only discovery archive transport has an explicit opt-in
for this exact `callTracer` request. Its default allowlist remains unchanged.
Trace requests share the existing single-slot pacing, cooldown, timeout and
response-size limits. Current public KOL membership and retained canonical
receipt context are checked before every external request; private-only wallet
activity does not authorize archive discovery. No public debug RPC, VPS node
configuration change or new credentials are required.

## Actual CENSUS evidence

- Creation block: **130665915**, 30 October 2026 at **12:34:28 UTC**.
- Canonical block hash:
  `0x289206991cb8f1372ed28ad0146604470a300524c9966903fdcb67ff123b6183`.
- Parent block 130665914 has empty token code; the birth block has the exact
  captured runtime. Both headers were checked against the owned node.
- Creation transaction:
  `0xa3ceba6babee4bb5afbbbdf12d4037de1f885d89d0f309e06087ef4e70a5605f`.
- The complete historical trace proves CREATE child `[0]` from
  `0xd91f7217ccfb22e5b38c80dbac4bf887f1e615d9` to the exact CENSUS contract.
- The creation is after the unchanged production tracking boundary 129627586.

The authenticated public fixture is
`server/fresh/fixtures/census-creation-discovery.json.gz`. It contains recorded
code/header observations, the full birth block, original deployment receipt and
complete trace. It contains no configured archive endpoint or credentials.

Offline decoding of 53 checksum-verified original captured receipts, gated by
this verified creation proof, produces **14 buys and 18 sells for eight KOL
wallets**. Fifty receipts normalize completely. Three incoming transfers keep
`incoming_transfer_cost_unknown`; their values and basis remain unknown.
Approvals and transfer receipts are not counted as trades. Original captured
trade-time metadata, conversions and fees are used, with no current-price
substitution, financial writes or network calls during replay of the evidence.

## Validation and release boundary

- 330 affected regression tests pass, including the authentic no-mint internal
  creation fixture, trace opt-in, tampered/truncated traces, boundary handling,
  discovery, token birth, admission and receipt decoding.
- 26 PostgreSQL queue/lease/privacy/publication checks pass using session-local
  temporary tables, all rolled back. Persistent writes: zero.
- Both TypeScript projects and the production build pass.
- Actual source proof replay and receipt results are retained under
  `.cache/token-fc967-diagnosis-20261101/verified-constructor.json` and
  `offline-decoding.json`.

The release changes no schema, storage retention, trading boundary, financial
policy or account/settings behavior. Existing database and cache volumes,
environment settings and the single capture owner must be preserved during
the ordinary image handoff. No timed validation automation or X publishing is
enabled by this change.

The shared discovery queue can admit the token, wake the existing bounded
decoder/admission work, and feed the ordinary token, accounting and chart
services. Production admission and recovered trades must be checked after the
image handoff; the offline fixture alone is not a production replay-video
check. Unsupported creation patterns or unavailable provider evidence remain
explicit pending states; the fix does not invent token age, prices,
transactions or acquisition costs.
