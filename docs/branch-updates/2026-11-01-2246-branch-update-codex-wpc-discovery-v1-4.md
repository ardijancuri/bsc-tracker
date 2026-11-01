# v1.5: Direct X token publishing, disabled at release

## Release scope

This release adds the direct X API publisher to Fresh v1.5. It remains disabled.
The application version stays 1.5.0. Base commit: e61e7b5fab56ec4ac66defd4fe31b73fe36b929f.
Branch: codex/wpc-discovery-v1.4. The remote main and working branch were verified
at that same base before preparing this commit; there is no local upstream configured.

## Behavior and data flow

The worker can select an eligible BSC meme token when at least four distinct
public tracked KOL identities still hold a positive confirmed balance after a
recorded public buy. Partial holdings qualify. Several wallets with the same
recorded X handle count once, with all balance proofs retained. Private Portfolio
activity and transfer-only holdings are excluded. Eligibility uses current
PostgreSQL positions and canonical capture evidence, independently of PNL,
market-cap thresholds and volume. No GMGN or financial-provider requests are made.

Captions retain the token name/ticker, current holding count, optional rounded
market cap, validated public X handles, full contract address and Kollens URL.
The approved 1200 x 675 image uses the app's Manrope font, token portrait and
rounded market cap. CJK/emoji use installed fallback fonts. No new public UI,
API publishing controls, navigation or signed media endpoint is introduced.

Direct media upload, OAuth identity verification, encrypted refresh-token
rotation and post creation use official X endpoints. PostgreSQL publishing jobs
have leases, token/account uniqueness, attempt evidence, 12-post Skopje daily
limits and ten-minute spacing. Unknown sends are reconciled and never blindly
retried. Canonical reorgs invalidate related work without deleting delivery proof.
Narratives remain disabled; preview and dry-run paths need no AI credentials.

## Disabled production contract

X_TOKEN_POSTS_MODE=disabled causes the publishing worker to return before its
schema setup, credential access or HTTP work. The release runtime pins that mode
explicitly and does not add production X credentials. No publisher tables or
financial migrations are needed during this rollout. If publishing tables are
already present, their enable switch must also remain false. Later activation
requires a separate explicit request and configured, funded X API access.

Existing Telegram consent, notification ownership and delivery settings remain
unchanged. Accounts, favorites, creator ownership, financial events, purchase
costs, fees, PNL, chart data and the tracking boundary are preserved. The BSC node,
private IPC configuration, database container and unrelated VPS apps are untouched.
The canceled timed local trial remains canceled.

## Verification

- Full Vitest regression suite: 5,591 passed across 305 files.
- Publisher PostgreSQL integration: 64 assertions passed, session-temporary
  tables only, fake transport and real network disabled.
- Both TypeScript projects: passed.
- Production build: passed before packaging; candidate entrypoints are hashed
  and bound to the committed source for the Linux release checks.
- Direct-X credentials and local historical delivery audit remained intact
  during removal of the retired adapter. No real post is part of this release.

## Deployment checks

Build a new immutable image with the additional locked fontkit/twitter-text
runtime packages and font fallbacks. Preserve current environment and mount
identities, adding only the explicit disabled publishing mode. Check the packaged
CLI with read-only database access, verify no publishing schema is created, and
preserve current and older open-tab assets. During the short app/worker handoff,
restart capture first, prove a fresh capture heartbeat, then accept public API
traffic. Compare pre/post financial evidence, memberships and account/settings
fingerprints. Do not reset a database or reproject accounting.

## Files

| File | Change |
| --- | --- |
| `.env.example` | Modified |
| `Dockerfile` | Modified |
| `compose.fresh.vps.yaml` | Modified |
| `docs/branch-updates/2026-11-01-2246-branch-update-codex-wpc-discovery-v1-4.md` | Added |
| `docs/x-token-posts.md` | Added |
| `package-lock.json` | Modified |
| `package.json` | Modified |
| `server/fresh/decode.ts` | Modified |
| `server/worker.ts` | Modified |
| `server/xTokenPostArtwork.test.ts` | Added |
| `server/xTokenPostArtwork.ts` | Added |
| `server/xTokenPostAuth.test.ts` | Added |
| `server/xTokenPostAuth.ts` | Added |
| `server/xTokenPostCard.test.ts` | Added |
| `server/xTokenPostCard.ts` | Added |
| `server/xTokenPostCli.ts` | Added |
| `server/xTokenPostContent.test.ts` | Added |
| `server/xTokenPostContent.ts` | Added |
| `server/xTokenPostEligibility.test.ts` | Added |
| `server/xTokenPostEligibility.ts` | Added |
| `server/xTokenPostFonts.test.ts` | Added |
| `server/xTokenPostFonts.ts` | Added |
| `server/xTokenPostRuntime.test.ts` | Added |
| `server/xTokenPostRuntime.ts` | Added |
| `server/xTokenPostSchema.ts` | Added |
| `server/xTokenPostTransport.test.ts` | Added |
| `server/xTokenPostTransport.ts` | Added |
| `server/xTokenPosts.integration.ts` | Added |
| `server/xTokenPosts.ts` | Added |
| `shared/xTokenPosts.ts` | Added |

## Handoff

The optional publisher is server-only; there is no mobile UI to mirror.
See ../x-token-posts.md for operator commands, setup and the exact eligibility
and delivery contracts. Production posting remains explicitly out of scope for
this release request.
