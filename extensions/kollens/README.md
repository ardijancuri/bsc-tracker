# Kollens Companion

Chrome Manifest V3 extension for matching the social links of distinct BSC token contracts. Includes matching outlines/badges, related-token groups, an account-synced saved-token workspace and private notes, conflict resolution, page alerts and opted-in audio. Its main UI is a **360 × 600 Chrome toolbar popup**, opened beneath the Kollens extension icon. Chrome 127 or newer is required for programmatic opening from a matching badge.

The local test build supports opt-in automatic BSC Trenches detection and matching highlights. Selectors were inspected in regular Chrome and tested with 23 captured GMGN cards, dynamic mutations and 230-card loads in isolated Chrome extension QA. GMGN authorization for automatic matching remains pending.

## Install the v1.5 download

1. Download and extract the [Kollens Companion ZIP](https://kollens.com/downloads/kollens-companion.zip).
2. Open `chrome://extensions`, turn on **Developer mode**, then choose **Load unpacked** and select the extracted folder containing `manifest.json`. To update an existing unpacked copy, extract the new files into its current folder and click **Reload** on its extension card.
3. In the Companion popup, open **Settings → About → Show trending BNB tokens** and approve the optional X site access in Chrome. **Trending Tokens** appears above **Today’s News** on X pages that show that sidebar card.

Build the same archive from source with `npm ci` followed by `npm run extension:download` in the repository root.

## Automatic GMGN matching — local test

Reload **dist-local**, open `https://gmgn.ai/?chain=bsc`, click the Kollens toolbar icon and choose **Enable on GMGN**. Accept Chrome's optional GMGN site-access prompt yourself. This is a one-time browser opt-in: new cards, social-link edits, recycling and sorting update automatically, including after reloads and in newly opened trenches tabs. Each tab matches only its own currently rendered cards. Changing chain or leaving trenches removes its decorations. Removing Chrome's GMGN site permission unregisters the script and clears existing highlights. The opt-in survives background-worker suspension and browser restart.

Matching cards receive colored outlines; matching social links receive small outlines in the corresponding colors. All reasons appear in the popup. No extra badge is inserted into GMGN cards because a badge slot clear of its trading controls has not been verified. Card dimensions, original links and trade controls are preserved. The initial scan is quiet; future group changes use the existing bounded activity and opted-in sound settings. Unsupported layouts fail explicitly.

Scripts run in Chrome's isolated world and read only rendered card identity/social links. They make no GMGN API requests and access no account sessions, wallet objects, application stores or private notes. No page scans or matching graphs are uploaded. There is no cross-tab or historical matching pool. The production-origin build retains its manual snapshot reader and cannot enable this local automatic mode.

Browser permission is not GMGN authorization. GMGN's [Terms of Service, section 8.8](https://gmgn.ai/static/tos.html) restrict unauthorized automated access and extensions. This local test mode does not establish GMGN approval or terms compliance. Production activation remains disabled.

## GMGN AI summary — local test

In the local GMGN build, click **AI summary** beside a supported match to read the first token’s rendered GMGN narrative. The same control is available on an open BSC token detail page. Chrome may request optional GMGN site access. To test a missing Trenches trigger in a temporary frame within the same tab, build with `node extensions/kollens/scripts/build.mjs --local-gmgn --gmgn-narrative-frame-test`. The public download excludes the summary reader and worker command pending GMGN authorization and production verification.

## Try the local demo

Open **http://127.0.0.1:3360/fixture** while the task-owned demo process is running. The page contains simulated tokens, not real trades. Add matching cards, sort, recycle or remove them, change chain, or add 200 cards. The panel and matching engine are the same modules used by the extension.

“Connect Kollens” opens a local connection page. Choose test account A or B, then explicitly connect. These are isolated test accounts; there is no real Telegram login, bot message, X post, financial collection or production account modification. A second browser profile can connect to the same test account to exercise sync/conflicts. The web preview keeps client state in its local helper process; the actual extension stores its pending drafts in trusted Chrome storage and survives service-worker restarts.

The demo database is **kollens_extension_local_20261102 on 127.0.0.1:5442**. Its data directory is `.cache/extension/pgdata`; it is independent of earlier Kollens databases. The demo refuses a connection outside the task-owned port/database prefix. Preserve its data when stopping or restarting it.

From the repository root:

```powershell
npm ci
npm ci --prefix extensions/kollens
node extensions/kollens/scripts/build.mjs --local
npm run demo --prefix extensions/kollens
```

The isolated PostgreSQL cluster must already be running on port 5442. Set `EXTENSION_DATABASE_URL` only for another task-owned `kollens_extension_*` database on that port; do not point this helper at an app or production database.

## Load the unpacked extension

1. Build with `node extensions/kollens/scripts/build.mjs --local`.
2. In Chrome’s extensions page, load **extensions/kollens/dist-local** as an unpacked development extension.
3. Open **http://127.0.0.1:3360/fixture?extension=1**. This variant uses only the actual Chrome content script; it removes the web-preview panel.
4. Pin Kollens Companion to Chrome’s toolbar and click its icon, or click a matching badge. The compact popup opens over the page without resizing it. It closes when you click elsewhere, following normal Chrome popup behavior.

The bottom bar opens **Wallets**, **Tokens**, **Settings** and **Account**, in that order. **Account** shows the verified email when available, the display name, a copyable UID, logout and linked social profiles. Google uses Chrome's sign-in window. Email addresses and one-time codes are entered in the extension. Reopen the popup after Google authorization to see the account. **Tokens** keeps the Matches, Saved and Activity tabs, stacked token rows, and source links. Market cap and volume use the displayed values and GMGN's default color tiers. A saved token shows dashes when its card is unavailable.

**Wallets** creates BNB Chain addresses with one click or imports a private key or the first standard EVM address from an English recovery phrase. New wallets use an encryption key stored in the Chrome profile. Imported and older password-protected wallets still use their wallet password. The wallet menu can show the receive address, send BNB, open BscScan, edit the alias, reveal the private key or archive the wallet. Archiving keeps the encrypted key and lets you restore the wallet. Use the unpacked Chrome extension for wallet testing. Enabling balances grants optional access to the BNB Chain RPC for public wallet address lookups.

The current workspace view and unsaved note text are retained locally per account when the popup closes. Reopening restores them; unsaved text is not uploaded until you explicitly save it. A badge click opens the matching group. The local web fixture shows the same floating popup and a Kollens button to show or hide it.

Token rows show rounded **36 × 36 thumbnails** from the token-logo image already exposed in GMGN's rendered card. New/lazy image sources update automatically; recycled cards do not retain another contract's logo. Platform/DEX badges are not used as token artwork. Missing or broken artwork falls back to the initial without repeated failed requests on popup refresh. Images use no-referrer requests and require no additional host permission or GMGN API key. No image matching is performed.

An explicitly saved token retains its optional public `logoUrl` along with its identity, so its Saved thumbnail remains available after its GMGN card leaves the page. The local extension schema adds a nullable, bounded `logo_url` column to the existing saved-token table; no financial table or collection changes are involved. Old clients that omit the field preserve the existing image. Only explicit saves upload this identity field; current-page images and matching graphs remain local.

The development extension ID is **ghfjmmhnnleieehnffpdaodgbbcloghf**. `development-key.json` contains a public development identity only; no signing private key or API credential is included. A future store build needs its own registered extension identity.

The production-origin build outputs `dist` and keeps automatic GMGN activation disabled. Only `dist-local` offers optional automatic mode. Persistent GMGN site access is requested by the popup's user click, then a narrowly scoped content script is registered. **Do not distribute `dist-gmgn-qa`**: it is an ignored QA-only build with up-front GMGN host access so isolated tests can exercise one-time activation without accepting a real permission prompt. Account endpoints require a later app deployment.

## Behavior and boundaries

- Matching is per tab and only includes currently rendered cards. Hidden, detached or invalid cards are excluded. Saved items and previous pages never expand this pool.
- Exact X post IDs, explicit X profiles, X community IDs and Telegram destinations are separate group types. Posts by the same author remain separate. Equivalent supported URLs normalize without network requests.
- Unsupported short links, generic platform links, websites and images are not matched. Missing social links remain visibly unavailable.
- Shared destinations indicate link reuse, not affiliation, authenticity, originality or verified virality.
- The first scan is quiet. Alert rendering is deduplicated, activity is bounded to 50 page-session entries, and audio has a 30-second cooldown. A sound preference synced from another browser does not activate this browser: local opt-in is also required.
- Match graphs, page scans and alert history remain in extension memory. Only explicitly saved identities/notes and preferences are synced. Matching does not use financial RPC or external social APIs.
- Saved tokens are a separate account-owned list, capped at 100 entries with 2,000-character plain-text notes. Pinning never starts collection or changes the existing app Watchlist.
- Notes and credentials are restricted to extension UI/background contexts. Content scripts cannot read trusted local storage. Pending changes are account-bound; account switches cannot send another account’s drafts.
- Conflicting edits retain the local draft. “Keep my draft” retries against the returned server revision; “Use synced version” explicitly discards the pending edit.
- The normal app, Telegram login, P&L, trade history, chart/replay data and X automation remain separate.

## Account API and later local app integration

The normal Fresh app registers extension routes only with:

```text
KOLLENS_EXTENSION_ENABLED=true
KOLLENS_EXTENSION_ORIGINS=chrome-extension://ghfjmmhnnleieehnffpdaodgbbcloghf
```

Keep `PUBLIC_APP_URL` set to the correct app origin. Unregistered extension origins fail closed. Chrome may omit `Origin` on privileged GET requests; the registered `X-Kollens-Extension-Origin` tag supplies routing context, never authentication. Bearer credentials or the pairing verifier are independently required.

Route families:

- `/api/extension/auth/*` creates scoped 30-day sessions using a verifier and single-use completion proof. Legacy clients can still use web pairing. Chrome sign-in from the popup leaves the website session independent.
- `GET /api/extension/workspace` returns the signed-in account’s saved items, preferences and verified profile details.
- `PUT/DELETE /api/extension/tokens/:address`: owner-scoped revision checks, bounded notes and atomic per-account capacity enforcement.
- `PUT /api/extension/preferences`: revision-checked updates preserving unrelated account preferences.
- `/extension/connect`: sign in with an existing web session, Google, an email code, or Telegram, then explicitly approve the connection. Google and email create separate accounts.

Google requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a registered `${PUBLIC_APP_URL}/api/auth/google/callback` redirect. Email requires `RESEND_API_KEY`, a verified sender in `KOLLENS_EMAIL_FROM`, and a random 64-character hex `KOLLENS_EMAIL_AUTH_SECRET`. Configured email sign-in adds the short-lived `auth_email_login_attempts` table. The standalone local demo uses its existing test accounts.

The Google flow keeps its existing server callback and returns to the extension through Chrome's `identity` API. A Google account's email becomes visible after a successful sign-in with a verified email claim. A prior email-only account shows its verified address after the next successful code verification.

To enable optional verified social profile links, register each callback with its provider:

- For Telegram, register `${PUBLIC_APP_URL}/api/auth/extension-social/telegram/callback` in BotFather and set `EXTENSION_TELEGRAM_LINK_ENABLED=true` alongside the existing Telegram OAuth client. The link requests profile access and does not enable alerts. [Telegram callback setup](https://core.telegram.org/bots/telegram-login#registering-your-allowed-urls)
- For X, register `${PUBLIC_APP_URL}/api/auth/extension-social/x/callback` on a dedicated confidential X OAuth 2.0 client. Set `KOLLENS_EXTENSION_X_CLIENT_ID` and `KOLLENS_EXTENSION_X_CLIENT_SECRET`. It uses the read scopes for the signed-in user's profile. [X authentication scopes](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping#user-lookup)

Social links only verify the profile displayed in Account. Login, Telegram alerts and the X publisher have their own permissions and credentials. Linking rejects a social profile already linked to a different Kollens account.

The extension workspace uses `extension_pairing_attempts`, `extension_saved_tokens` and `extension_account_links`. Existing `auth_sessions` gains a `purpose` field defaulting to `web`. Extension credentials cannot authenticate normal website-cookie routes. Per-token revisions remain monotonic across deletion/recreation, preventing old drafts from overwriting a recreated row. Expired pairing rows are pruned on new pairing requests, and outstanding attempts are globally bounded.

## Validation

```powershell
npm test --prefix extensions/kollens
npm run check --prefix extensions/kollens
node --import tsx server/extensionApi.integration.ts
node --import tsx server/googleAuth.integration.ts
node --import tsx server/emailAuth.integration.ts
npm run test:browser --prefix extensions/kollens
node extensions/kollens/scripts/unpacked-test.mjs
node extensions/kollens/scripts/build.mjs --local --gmgn-qa
node extensions/kollens/scripts/gmgn-live-test.mjs
npm run test:thumbnails --prefix extensions/kollens
npm run check
npm run build
npm test
```

Browser scripts resolve paths from their own location and write reports/screenshots to `.cache/extension/qa`. Browser tests require Playwright’s Chrome for Testing (`npx playwright install chromium` in this package) and the local demo. Dependencies are development-only.

Tests cover URL normalization/unsafe links, independent groups, duplicate pools, quiet baselines/cooldowns, sorting/recycling/hidden cards, offline drafts, stale revisions, account changes, private storage restrictions, one-use pairing, concurrent capacity limits and actual unpacked-Chrome audio and panel opening. The fixture benchmark uses 200+ rendered cards and includes the 40 ms debounce in its reported highlight latency.

## Remaining production GMGN acceptance work

1. Retain the GMGN team’s response covering both card reading and highlights.
2. Repeat hands-on inspection on the latest GMGN page after the user enables Chrome site access. A sanitized rendered-card fixture and its proven selectors are already retained.
3. Verify a safe badge anchor before adding any badge to GMGN; the local build currently uses outlines only. Unsupported layouts must continue to fail closed.
4. Complete a real-page smoke test with new arrivals and actual current layouts. Captured-DOM QA already covers SPA chain changes, virtualized-card identity changes, trading controls, worker restart and 230-card performance.
5. Review a separate activation change registering only the authorized hosts/routes. Commit, deployment and Chrome Web Store publication require a later release request.

No previous eight-hour validation automation is restarted by this work.
