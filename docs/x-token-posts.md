# Automated token posts on X

The worker selects confirmed BSC meme tokens when **at least four distinct public
tracked KOLs still hold a positive quantity after a recorded public buy**. Partial
sales qualify while a positive balance remains. Fully exited wallets, wallets
with only an airdrop/transfer and private Portfolio scopes do not count. There is
no minimum holding amount, purchase-time window, volume or market-cap threshold.
Several holding wallets with the same recorded X username count as one KOL
(case-insensitively, including recorded X profile URLs). Every wallet balance
proof is retained. Without a recorded X identity, the public roster wallet is
counted separately; display names are never used to merge identities.
Existing meme and reward/dividend/quote/LP/stock exclusions remain in effect.

Eligibility version 2 (`current_holders_v1`) reads the existing Fresh current
positions, matched node balance proofs, public KOL scopes and canonical buy facts.
Unknown FIFO costs/fees do not block holdings eligibility. Old hourly-trader jobs
must be reevaluated; they cannot publish with the former policy. Before delivery,
the holder count and proof revisions are checked again, including after upload.
A complete exit or transfer out removes the holder from qualification.

Capture must be current within two minutes. An older matched balance remains
usable when no later captured movement, undecoded receipt or collection gap can
change it; holding a token for hours does not itself expire eligibility. Financial
metrics are optional display data and never substitute for balance evidence.
Missing/stale market caps are omitted from captions and shown as a dash on cards.
Fresh does not retain market-wide swap volume, so it is unset rather than replaced
with KOL-only volume or an invented zero. No market-history tables or financial
provider calls are required by eligibility. Scans do not write financial data.

The publisher is integrated locally into Fresh v1.5. The Fresh worker runs it only
when explicitly configured for `dry_run` or `live`; the normal disabled startup
performs no X schema writes, credentials refresh or provider calls. Its build
includes `dist-server/xTokenPostCli.js`. No API/frontend X credentials or public
publishing controls are added. A future production release and separate explicit
activation are still required; local integration does not activate the live app.

## Local operation

The publisher uses the official X API for account verification, direct PNG upload
and post creation. API billing/credits belong to the connected X developer app;
funding that account does not enable this worker. The existing server-only X OAuth
connection is preserved, and both publishing gates remain disabled until an
explicit activation. No public image host is required for direct X media upload.

Publishing is **disabled by default**. No X or OpenAI credentials are required to
exercise the factual fallback. Keep credentials in ignored `.env.x.local` (never
in `VITE_` variables); the commands also read the existing `.env`.

```powershell
npm run x-posts -- status
npm run x-posts -- init
npm run x-posts -- verify
npm run x-posts -- preview --offline --out .cache/x-token-posts
npm run x-posts -- preview --offline --token 0x0000000000000000000000000000000000007777
npm run x-posts -- dry-run --offline
npm run x-posts -- pause
```

`preview` produces PNG/JSON artifacts without publishing. `dry-run` collects and
prepares up to twelve local jobs using the facts-only path, without model charges
or publishing calls. The background `dry_run` mode also forces facts-only content. A local
cloned database may use `--as-of <ISO timestamp>` for preview/dry-run; this forces
offline content and is rejected outside explicitly named localhost Fresh/test
databases (including the existing port-5439 replay-gap clone).
An old clone may have no eligible tokens: the output reports the checkpoint or
eligibility result instead of substituting fabricated financial data.

Sample cards are 1200 × 675 PNGs. Captions always retain the full token CA and
the fixed **`https://kollens.com`** footer, using X's weighted character count.
An empty line follows the token identity and precedes the CA. Token metadata,
Token/display names cannot inject URLs or mentions. The caption can mention
only strictly validated X usernames recorded on the participating public KOL
profiles; it never guesses handles from display names. Narratives and
"Narrative unavailable" placeholders are omitted entirely.
The image follows the trade replay design: a solid gold frame/footer, rounded
near-black main panel, 404-pixel token portrait, warm muted labels,
and large white metric values. The exact Kollens wordmark sits in the gold footer.
All supported text uses the same bundled `@fontsource/manrope` faces as the app.
The renderer draws their glyph outlines, avoiding native SVG engines silently
substituting Arial. CJK/emoji outside Manrope retain system-font fallbacks.
Unavailable market-wide volume is omitted from the image, with the current
market cap displayed in a single larger row. The right side uses a larger wrapped
token title, gold ticker and large market-cap figure in one left-aligned stack on the main panel.
The market-cap label and value share a compact borderless rounded container,
with equal outer spacing to the main panel's right and bottom edges; there is no
horizontal divider. No KOL identities/counts are added
to the image; the caption describes holders.
The token name leads the right-hand text area, followed by its ticker and any
available metrics with 24-pixel labels and large values fitted to width.
The volume label identifies the captured amount as observed;
neither metric has a comparison-symbol prefix. The image has no KOL identities,
KOL count, buyer/seller counts, contract address, observation-time footer,
descriptions or narrative/status copy. The caption retains the KOL count and
full CA, plus up to five distinct recorded `@usernames` and a remaining-KOL count
when needed. Usernames are never truncated; whole mentions are dropped when
needed to fit X's weighted limit. Missing/invalid usernames are omitted rather
than replaced with display names. Observation time and complete participant details
remain in stored evidence.
The plate has no baked-in financial values; text and cached artwork are composed
deterministically. Token artwork comes only from bounded database bytes;
rendering never fetches image URLs or loads KOL artwork.
Missing artwork never blocks preparation. Posts currently contain token identity,
recorded metrics, participating KOLs, the CA and Kollens URL only. The design does
not draw a market curve without genuine market history. It uses the existing
replay-style vector composition; no AI-generated artwork is needed.

## Narratives paused

Narratives are disabled in automated preparation, previews and captions. No
source lookup or model request is made, even if `OPENAI_API_KEY` is configured.
Publication does not set X's AI-content flag: the current text is deterministic
and the image composes genuine cached artwork and recorded metrics.
Existing source/model helpers and their regression tests remain dormant for a
possible future reintroduction; they are not the publisher's default path.

The GMGN website's AI narrative is not currently an integrated source. GMGN's
[icon documentation](https://docs.gmgn.ai/index/featured-icon-definition) identifies
the token-page AI icon: hovering displays an AI-analyzed narrative summary;
clicking searches X for the token name and CA. That confirms the UI feature, but
does not establish a supported API endpoint for its summary. The documented
token-info response exposes `link.description`, which is token
metadata rather than a verified AI summary. A local official CLI inspection on
2026-10-20 found no narrative/summary field and an empty description for the
sample token. Do not substitute that metadata for GMGN's AI text, scrape a
private website endpoint, or invent a narrative. A supported narrative response
and its provenance must be established before adding that integration.

The follow-up local capability test used the exact screenshot token,
`0x7ffcf7b3b52adcc00c76f50ce2e37bf3c7e215dc`, with both existing accounting and
market credentials. Both official `token info` requests succeeded and returned
an empty `link.description` with no narrative/summary field. The normal logged-out
browser displayed a real narrative through `IconNarrative16pxRegular`; this
establishes that the website content exists, not that OpenAPI exposes it.
Two exploratory key-authenticated OpenAPI routes (`/v1/token/narrative` and
`/v1/token/ai_summary`) returned 404 and are not production dependencies.
Direct website/static-resource requests returned 403; no browser credentials,
anti-bot bypass or private website adapter was added. Narratives have since been
removed from posts. Local credential-free reports and the UI proof
are in ignored `.cache/x-token-posts/gmgn-research/`.

The dormant optional helper uses bounded, cached research with contract-matched HTTPS
project pages and official X posts, and preserves source observation times.
Website fetching blocks private addresses and pins DNS results. Sources are
untrusted data. A structured, short extractive theme must point to a verified
source and pass content checks; unsupported claims and failures use facts only.
Each durable job reserves its model attempt before the request. Retries reuse
saved content; a crash after reservation falls back rather than charging again.
Live preparation waits for the next available publication slot and does not
research a backlog while the daily limit or ten-minute spacing blocks delivery.

## X account setup (later activation)

1. Sign in at the [X Developer Console](https://console.x.com), create or open
   the Kollens publishing app, then enable OAuth 2.0 in its authentication
   settings. Select **Web App** or **Automated App / Bot**: both are confidential
   server clients. If the console also shows an app-permission selector, choose
   **Read and write**, without Direct Messages; that selector governs OAuth 1.0a,
   whereas this integration requests OAuth 2.0 scopes during authorization.
2. Set the callback URL to **`http://127.0.0.1:4387/callback`** and the website URL
   to **`https://kollens.com`**. The callback must match exactly, including the
   port and path, with no trailing slash. X permits loopback HTTP for local
   development; use `127.0.0.1`, not `localhost`.
   [App settings and callback requirements](https://docs.x.com/fundamentals/developer-apps)
3. From **Keys and Tokens**, copy the **OAuth 2.0 Client ID and Client Secret**
   into the ignored `.env.x.local` file as `X_CLIENT_ID` and `X_CLIENT_SECRET`.
   These are distinct from the OAuth 1.0a API Key/Secret and the app-only Bearer
   Token; those credentials cannot replace them here. Also configure
   `X_TOKEN_POST_ENCRYPTION_KEY` (32 cryptographically random bytes, base64) and
   retain **`X_TOKEN_POSTS_MODE=disabled`** for the connection test. Keep the
   encryption key backed up privately: it decrypts the saved access/refresh
   credentials. Never print, paste into chat, commit, or expose these values in
   frontend configuration.
4. Add API credits and set an appropriate spending limit in the Developer
   Console. X API access uses credit-based, pay-per-usage billing; connection
   verification and later publishing can incur API charges.
   [Current billing and credits](https://docs.x.com/x-api/getting-started/pricing)
5. Run `npm run x-posts -- connect`, open the printed authorization URL, and
   authorize **@kollens**. The command requests `tweet.read`, `tweet.write`,
   `users.read`, `media.write`, and `offline.access` itself; no manual token
   generation or scope selection in the console is needed. It uses a single-use
   PKCE/state loopback callback and verifies the returned account. OAuth tokens
   are encrypted in PostgreSQL; refresh-token rotation is serialized and
   persisted. Check the result with `npm run x-posts -- status`. **Connecting and
   checking status do not publish a post or enable automated publishing.** The
   bot's Telegram credentials are unrelated.
   [OAuth 2.0 scopes and refresh access](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
6. For a remotely run operator command, forward port 4387 through an authorized
   SSH tunnel so the local browser callback reaches the remote command. Do not
   expose the callback listener or node debug RPC publicly.
7. After local validation and a separately requested production release, set
   worker-only `X_TOKEN_POSTS_MODE=live` and explicitly run
   `npm run x-posts -- enable`. Both the configuration gate and database enable
   switch are required. **Connecting credentials does not enable publishing.**

In the production image use `node dist-server/xTokenPostCli.js <command>` rather
than the source-tree npm command: development tooling is pruned from that image.
Run it in the worker's environment, for example
`docker compose exec worker node dist-server/xTokenPostCli.js status`. This
project's worker uses host networking, so its loopback OAuth listener is reached
through the operator's SSH port forward; keep it loopback-only. A different
network topology requires an equivalent private tunnel, not a public port.

The existing Compose worker receives these server-only settings; the API and
frontend do not receive X/OpenAI secrets. No public admin endpoint is added.
The runtime image includes Latin/CJK fonts for token and public KOL names.

Official references: [OAuth](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token),
[create post](https://docs.x.com/x-api/posts/create-post),
[upload media](https://docs.x.com/x-api/media/upload-media),
[pricing](https://docs.x.com/x-api/getting-started/pricing),
[model](https://developers.openai.com/api/docs/models/gpt-5-nano).

## Delivery, limits and recovery

Collection runs every 30 seconds. Independent preparation/delivery loops use
PostgreSQL leases and a unique chain/token/account job. A token is published
successfully at most once. Before dispatch, fresh eligibility and canonical
proofs are checked again and the card/caption share the same frozen evidence.

At most **12 posts per Europe/Skopje calendar day**, at least **10 minutes apart**.
Unknown sends conservatively reserve quota. Candidates that cease qualifying are
deferred without consuming their lifetime publication allowance; hard provider
rejections require inspection. Provider cooldowns are shared through the database.
Pausing prevents future dispatch, including work currently preparing; an already
dispatched HTTP request cannot be recalled.

The worker stores prepared bytes, sources, attempts, media IDs and returned post
IDs. An expired send lease becomes uncertain, never an automatic resend. After
two minutes, the worker reconciles exact caption/media evidence against the
verified account's timeline. A found post is recorded as sent; an unconfirmed
send is marked for inspection and will **not** be resent automatically.
Timeline reconciliation restores only the fixed Kollens footer from validated X
URL entities before matching the saved caption; unrelated links cannot establish
a successful match.
`npm run x-posts -- reconcile` performs the next due reconciliation without
publishing a new post. `status` reports job counts and connection metadata.

Reorg rollback cancels unpublished affected jobs and marks sent/uncertain work
for inspection while preserving publication evidence. Diagnostics record
eligibility, queue timings, source/model requests, fallback reasons, sends and
cooldowns without full provider responses, captions or credentials.

## Tests

```powershell
npm run check
npm test
npm run test:integration:x-posts
npm run build
```

The integration suite uses **session-temporary tables only** and fake transports.
It permits named localhost `bscan_x_posts_test` databases or the existing isolated
`kollens_replay_gap_20261029` clone on port 5439. Fresh SQL is redirected to TEMP
fixtures on one dedicated connection; it never drops an application schema or
writes application financial records. This fixture program exercises real SQL
and fake delivery; separate-session production concurrency is not established by
its shared temporary session. VPS connections are rejected. Real posting,
deployment and activation remain separate operator actions.
