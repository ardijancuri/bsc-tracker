# Telegram login setup

Telegram login is optional. Visitors can follow tokens and KOLs without an account. Logged-in favorites and filter preferences persist across devices; logging out does not delete them.

## Bot-first sign-in

The header **Login** button opens the verified Kollens bot with a random ten-minute `/start` challenge. The bot sends **Continue to Kollens** privately, using a different one-time token. Returning to the browser that began sign-in completes it automatically through a same-origin POST after the server rechecks the browser binding. There is no normal confirmation card or post-login alerts popup. GET/HEAD and API previews do not create sessions. A link opened in a different browser or issued directly from the bot keeps one compact account confirmation to prevent forwarded-link login CSRF.

Return tokens are URL fragments, removed immediately by the app and stored only as hashes on the server. Do not forward a login link. Duplicate webhook delivery does not resend it. Expired or completed links cannot be reused; a fresh `/start` can replace a failed link after any delivery cooldown.

Accounts with a verified numeric Telegram ID keep the same favorites, journal and creator ownership. If older accounts without this identifier still exist, an unfamiliar ID requires one-time OIDC verification before account creation, preventing empty duplicate accounts. Recovery remains available when verification is required or a login error occurs. Accounts are never matched by display name or username.

Guest favorites merge only when the return opens in the browser that began sign-in. A different browser signs in independently and does not import the original browser's guest favorites. A different signed-in account must log out explicitly before completing a bot link. Login does not enable trade alerts.

## Configure the dedicated bot

1. Create a dedicated **Kollens Login** bot in [BotFather](https://t.me/BotFather), using the Kollens name and logo.
2. Open the bot's **Login Widget** settings. Register the production callback exactly as `https://kollens.com/api/auth/telegram/callback`. Register any separate development callback too; Telegram redirects only to allowed URLs.
3. Obtain the **Client ID**, **Client Secret** and the same bot's **HTTP API token**. OIDC credentials remain necessary for legacy account recovery and separate alert consent. Keep the default RS256 signing algorithm. Kollens does not request your phone number.
4. Put credentials in the private server `.env`:

   ```dotenv
   PUBLIC_APP_URL=https://kollens.com
   TELEGRAM_CLIENT_ID=your-client-id
   TELEGRAM_CLIENT_SECRET=your-client-secret
   TELEGRAM_BOT_TOKEN=your-login-bot-api-token
   TELEGRAM_WEBHOOK_SECRET=a-long-random-secret-using-letters-digits-underscores-and-hyphens
   ```

Do not prefix credentials with `VITE_`, add them to frontend configuration, paste them into chat, or commit them. The ignored `.env` stays on its host. Bot-first login uses Telegram's [private deep links](https://core.telegram.org/bots/features#deep-linking) and authenticated webhook. [OIDC](https://core.telegram.org/bots/telegram-login) remains separate for recovery and messaging consent. Configure the webhook before enabling bot-first login; alert delivery remains optional.

## Optional favorite-KOL trade alerts

Use the **same bot** for login and alerts. Obtain its Bot API token from BotFather and add these server-only settings:

```dotenv
TELEGRAM_BOT_TOKEN=your-login-bot-api-token
TELEGRAM_WEBHOOK_SECRET=a-new-long-random-secret-using-letters-digits-underscores-and-hyphens
```

The bot token prefix and its verified `getMe` identity must match `TELEGRAM_CLIENT_ID`; another bot is rejected. The API uses the Bot API token for login replies and the OIDC secret for consent; the worker uses the bot token for alert delivery. Keep the client ID, app origin, token and webhook secret consistent between API and worker. Never print credential-bearing Bot API URLs or complete provider responses. Optional photos are downloaded server-side, normalized and served only to their signed-in owner.

While signed in, users explicitly enable **Telegram alerts** in the Watchlist KOL tab. This starts `openid profile telegram:bot_access` consent with nonce, PKCE, browser and current-session binding. A different Telegram account is rejected without changing the Kollens login or favorites. The signed numeric profile `id` is stored separately from opaque OIDC `sub` and becomes the destination chat ID. The worker must send an activation confirmation successfully before alerts become enabled. Cancellation or delivery failure leaves a reconnect state.

For an authorized production release, register `https://kollens.com/api/telegram/webhook` using Telegram's `setWebhook` method with the configured `secret_token` and `allowed_updates` containing `message` and `my_chat_member`. Use a private server administration script that reads secrets from the environment; do not place a credential-bearing command in shell history or deploy output. The app never automatically registers or changes a webhook. A bot has one webhook: local tests must not replace the production webhook.

Private-chat `/start` sends a one-time login link first, including when opened without a deep-link parameter. `/start login_…` keeps the original browser handoff when that challenge is available; an expired or unknown challenge offers a fresh bot-origin login link without importing guest favorites. `/status` shows alert settings, and `/stop` pauses alerts and cancels pending deliveries. None of these commands enables alerts automatically. Blocking the bot disables delivery and requires reconnection. Webhook requests require the configured secret header and updates are durably deduplicated separately for login and alerts.

Only confirmed, live-observed trades by tracked, favorited KOLs qualify. Historical imports and repairs are silent. The first eligible trade is sent promptly; later trades from the same KOL are grouped into fixed ten-second summaries with buys and sells separated. Pending trades older than five minutes are skipped. Pausing, muting, unfollowing and side filters are rechecked before dispatch. Neither GMGN nor P&L/replay readiness is involved. Delivery respects per-chat and global pacing; provider cooldowns are retried, while an uncertain post-send response is retained for inspection instead of blindly duplicated.

## Local testing and release

After a successful login, users return to Kollens without an alert invitation modal. Telegram alerts can be enabled or resumed manually in the Watchlist KOL tab, with separate explicit messaging consent. The header Login button retains its appearance while sign-in starts.

The Watchlist KOL tab places followed KOLs on the left and Telegram settings on the right; settings move above the list on mobile. Radar filters stay separate. Trade messages use buy/sell emojis, bold names and values, linked token names, plain UTC trade times, and Kollens navigation buttons. BscScan links are omitted. Formatting uses explicit [Telegram message entities](https://core.telegram.org/bots/api#messageentity), so token metadata is never interpreted as HTML or Markdown.

Use a separately registered HTTPS development origin, with its `/api/auth/telegram/callback` URL and matching `PUBLIC_APP_URL`. Use localhost only if BotFather explicitly accepts that callback. The development address must serve both the frontend and `/api` routes; do not point Telegram at the backend while browsing a different origin.

For local development, save `TELEGRAM_CLIENT_ID` and `TELEGRAM_CLIENT_SECRET` in the ignored `.env.telegram.local` file. `npm run dev:api` reads `.env` first and then `.env.telegram.local`; keep the development `PUBLIC_APP_URL` matched to the frontend origin. For example, if BotFather accepts it, use `http://127.0.0.1:5173` and register `http://127.0.0.1:5173/api/auth/telegram/callback`.

Run `npm run dev` and `npm run dev:api` with a private development database. Missing login/bot configuration disables the entry point while guest stars still work. Test the complete bot flow with a fake Bot API and authenticated webhook injection in a disposable database. A real local test needs a separate development bot/webhook or a narrowly scoped test relay; never replace the production webhook. OIDC recovery tests still use a signed test identity provider. `npm run test:integration:auth` requires a disposable `bscan_auth_test` database; never run integration resets against application data.

Before issuing a bot handoff, the API checks `getWebhookInfo` against its own fixed `${PUBLIC_APP_URL}/api/telegram/webhook` URL. If the shared bot still points to production while the app runs locally, Login shows a clear mismatch message instead of opening a link that the live server cannot resolve. This check is read-only and never registers, deletes or redirects the bot's webhook.

`npm run test:integration:bot-login` requires a fresh, empty local database named `bscan_auth_bot_test` or `bscan_auth_bot_test_<number>`. It uses real PostgreSQL transactions and a fake Telegram transport, forbids external HTTP, and refuses existing schemas instead of resetting them.

Before enabling login live, verify a real approval, cancellation, return to the original page, guest merge, and access to the same token/KOL favorites in a second browser. Verify logout and guest behavior separately. Migrations are additive; take the normal database backup before deployment. Configure credentials on the VPS, then rebuild/restart through the standard release process.

Notification tests use an injected fake Bot API transport and a disposable integration database. Do not point notification test fixtures at application data. For a real local message check, explicitly opt in using a test account, approve fresh messaging consent and verify the activation before testing a newly confirmed trade. Production webhook registration and production delivery validation follow a separately authorized release. Keep the existing live webhook untouched during local development.

## Data and account behavior

The backend verifies Telegram identity before creating a local account. Telegram identity, favorites and preferences are stored in PostgreSQL; session secrets are hashed before storage. Account favorites do not expire when a device's 30-day login expires. Browser-only favorites retain the existing guest lifetime.

Telegram alert settings are separate from Radar filters. Alerts default off; once enabled, new favorite KOLs are included from their favorite time unless individually muted. Activation, resume and unmute boundaries prevent older trades from being delivered. Notification settings, verified chat IDs, update IDs and delivery evidence survive API/worker restarts. A reorg cancels pending orphaned trades and schedules corrections for already delivered messages. Operational metrics contain counts, timings and fixed failure categories, never tokens or complete message bodies.

Sign-in merges guest tokens and KOLs, preserving the account's existing filters. New accounts inherit guest filters. Each kind has a 100-item limit; an over-limit merge cancels login without modifying either list. Remove some guest or account favorites and retry. Clear Watchlist removes favorites and resets filters while keeping the current account signed in. Logout revokes only this device's login and starts an empty guest list; it does not erase account favorites.
