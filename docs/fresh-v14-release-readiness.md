# Fresh v1.4 local release preparation record

Fresh v1.4 was subsequently committed and deployed on October 25. See
[the completed release](fresh-v14-release-20261025.md) for current production
status. The measurements below record the earlier local preparation state.

Final local runtime: `dd60353513240af656375c9bfa2c14d6536e9841ca98e681f753c61bfc94ce5a` (October 25, 2026).
The ordinary app is running at http://127.0.0.1:5173 with API port 3302 and the
separate local PostgreSQL database on port 5436. The canceled eight-hour trial remains
closed; its 4160.051 audited seconds and every prior report are retained.
At this local preparation checkpoint, nothing had been committed, pushed or
deployed. Original checkout X work, old databases and migration copies remain
preserved after the later production release.

## Accounting fixes and remaining historical gaps

The approved actual-acquisition policy is implemented for all ten affected
native-to-NVDA-quote purchases. Exact original BNB cost is split proportionally
between the purchased token and returned quote dust. Original gross BNB amounts
stay in trade details; gas stays separate and is charged once. Compact typed
acquisition provenance is stored in one JSONB column so the basis survives raw
receipt expiry. This does not introduce another table or a market-price claim.

All 16 targeted receipts completed ordinary decoding: the ten allocation cases,
one canonical parent-state proof, three authenticated signed self-call cases
and two fully conserved WBNB exchanges. All 242 earlier recovered native trace
targets now have known purchase values and completed decoding. Supported
metadata, transfer warning, precision and isolated-incoming fixes retain unknown
costs when genuine evidence is absent. Original IDs, quantities and fees are
preserved except for the two specifically reviewed, previously approved signed
batch-expense enrichments.

At 02:13 UTC, 74 of the original 122 incomplete KOL books were currently complete;
48 retained historical gaps. 332 of 476 original unknown trade values were
recovered. No completion was credited solely to rolling-window expiry. The
whole current roster at 02:19 UTC had 29 ranked complete wallets, 147 complete
inactive wallets and 50 incomplete wallets, including two outside that original
cohort. These are dated audits, not a claim that every historical trade is fixed.

The public archive provider exhausted its daily quota. The user explicitly
chose to keep the remaining gaps visible. No additional endpoint was configured,
no further archive retries are running and unknown costs are not replaced by
current prices or zero values. Incomplete totals stay outside ranked positions.

Every one of 226 stored rolling 24-hour realized totals independently matches
canonical result/fee deltas at its stored observation time. Rankings use exact
rational values in descending order and only complete totals. Eight profile/
leaderboard profit and revision pairs match. Six private routes returned 401;
twenty leaderboard reads had measured p95=20.37 ms. Normal pages read stored
metrics and do not replay historical RPC or FIFO accounting.

## Charts, replay and startup

GMGN replay preparation now reuses the genuine historical coarse/fine seam,
avoiding a redundant coarse-tail request on retry. Original timestamps and real
coverage gaps remain visible. Provider cooldowns still receive bounded retry
statuses; chart availability is independent of node P&L. Both the repaired closed
Hamburger replay and the current open Mumu/BIBI preparation returned ready on
the final runtime.

A new final-build Hamburger MP4 was generated, downloaded and played to its end:
1080x1350, 15.5 seconds, 8852863 bytes. Independent twelve-event sums equal the frozen
modal/video: profit 168.82816547339259509051357941, acquisition capital including
purchase fees 109.9011858728316148296, ROI 1.536181471860970746901325492800366436.
The new signed manifest validates. Earlier BIBI/Hamburger artifacts remain.
The local signing secret is process-local when FRESH_REPLAY_SECRET is unset;
pre-restart leases must be prepared again. The initial stale-lease harness
failure is retained; final evidence uses a fresh final-runtime lease.

Startup now prevents the reproduced reader/DDL inversion by acquiring the
existing schema/financial/helper guards before NOWAIT relation prelocks. Helper
DDL uses savepoints within one outer transaction. Every failed attempt rolls
back and releases all locks before retry. Five attempts have up to 30 seconds of
backoff, accommodating the observed routine autovacuum without silently
ignoring errors. Original schema SQL and legacy-database refusal are unchanged.

## Final verification and preservation

On this exact final source:3583 regression tests pass, zero fail, two optional
tests skip; both TypeScript projects, production build and all 16 PostgreSQL
integration programs pass. The real reader, financial writer, standalone helper
and routine-vacuum failure paths were tested and independently reviewed. Initial
deadlock/busy failures and all later passing reports are retained. Telegram
delivery used fake transport only; no real Telegram or X messages were sent.

The final 02:25 UTC preservation audit retains all 10242 baseline financial IDs,
all 21058 original transaction/receipt bodies and all 15 identity/settings/delivery
digests. There are no unexpected changes to known numeric financial values.
Boundary 129180844/hash
`0x32588e1f98d9d2c5bf163a8700ac3740b4aaf86237e57d9f0f86406600c90103`
and 4160.051 prior healthy seconds are unchanged. The verified 239879368-byte
snapshot-consistent baseline dump, all old databases and all fixture databases
remain. Original evidence was enriched, not deleted or silently reinterpreted.

Measured 02:19 UTC allocation of the Fresh database was 544683711 bytes across 35
base tables. Shared/local retained storage is reported separately:

| Category | Bytes |
| --- | ---: |
| Permanent compact financial data | 34021376 |
| Temporary 72-hour evidence and headers, including TOAST | 324132864 |
| Current identity and feature data | 50233344 |
| Relation indexes | 118243328 |
| Shared disk chart cache, separate | 1684418 |
| Shared PostgreSQL cluster WAL, separate | 201326592 |
| Retained local task logs, separate | 14346581 |

Database catalogs/other allocation account for the remainder of the database
total. Old databases, exports, private QA evidence and MP4 artifacts are separate
preserved workspace storage. These are actual allocations, not growth estimates.

## Production release gates

Authorized read-only cutover preflight is complete: 54 targeted tests, 17
PostgreSQL handoff checks, actual VPS Compose rendering, free loopback candidate
ports and disabled preview messaging. The exact Linux Node IPC adapter returned
a genuine confirmed trace. A consistent read-only production export of 21 feature
tables plus 229 KOL identities passed typed local import with all 22 dataset
digests equal, preserving sessions, Telegram settings and private Portfolio
membership. The unchanged operator/Compose/IPC paths are separately hash-bound.

The agreed production release starts at a separately approved new boundary;
this local trading test database is preserved and is not imported as production
financial history. A later explicit release request must still perform:

1. Build and verify the exact Linux candidate image/native dependencies.
2. Create the candidate worker and verify its actual private IPC mount and
   permissions. The legacy stale socket bind found during preflight is untouched.
3. Pause settings writers for a sealed release export/import, then verify the
   actual candidate preview, assets and existing-login continuity.
4. Drain/seal the legacy collector/sender, prove canonical B-to-C handoff,
   activate explicitly and switch live traffic during the agreed maintenance.

These production checks were still outstanding at the local preparation
checkpoint and were completed during the later authorized release. Local code
verification does not substitute for the recorded candidate-image/mount/export/
activation checks. See [the release record](fresh-v14-release-20261025.md),
[cutover](fresh-production-cutover.md) and [deployment](fresh-v14-deployment.md).

## Evidence

- Final tests and sixteen-program reports: `.cache/fresh/private/v14-final-candidate-20261025/`.
- Exact reviewed startup fixes: `.cache/fresh/private/schema-reader-startup-20261025/`.
- Financial/cohort/preservation audits: `.cache/fresh/private/v14-accounting-gaps-20261024/`.
- Final actual video, screenshot, independent arithmetic and manifest: `.cache/fresh/final-v14-dd603-live-20261025/`.
- Read-only cutover: `.cache/fresh/private/cutover-checks-20261025/`.

The private evidence contains account/session data and is not a public artifact.
