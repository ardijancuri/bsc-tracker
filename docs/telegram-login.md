# Telegram login setup

Telegram login is optional. Visitors can follow tokens and KOLs without an account. Logged-in favorites and filter preferences persist across devices; logging out does not delete them.

## Configure the dedicated bot

1. Create a dedicated **Kollens Login** bot in [BotFather](https://t.me/BotFather), using the Kollens name and logo.
2. Open the bot's **Login Widget** settings. Register the production callback exactly as `https://kollens.com/api/auth/telegram/callback`. Register any separate development callback too; Telegram redirects only to allowed URLs.
3. Obtain the **Client ID** and **Client Secret** from those settings. These OIDC credentials are separate from the Bot API token. Keep the default RS256 signing algorithm. Ordinary login requests `openid profile`; optional trade alerts use a separate consent flow described below. Neither flow requests a phone number.
4. Put credentials in the private server `.env`:

   ```dotenv
   PUBLIC_APP_URL=https://kollens.com
   TELEGRAM_CLIENT_ID=your-client-id
   TELEGRAM_CLIENT_SECRET=your-client-secret
   ```

Do not prefix credentials with `VITE_`, add them to frontend configuration, paste them into chat, or commit them. The ignored `.env` stays on its host. The application uses Telegram's [documented OpenID Connect flow](https://core.telegram.org/bots/telegram-login). Login remains usable without configuring notifications.

## Optional favorite-KOL trade alerts

Use the **same bot** for login and alerts. Obtain its Bot API token from BotFather and add these server-only settings:

```dotenv
TELEGRAM_BOT_TOKEN=your-login-bot-api-token
TELEGRAM_WEBHOOK_SECRET=a-new-long-random-secret-using-letters-digits-underscores-and-hyphens
```

The bot token prefix and its verified `getMe` identity must match `TELEGRAM_CLIENT_ID`; another bot is rejected. The API uses the OIDC secret for consent; the worker uses the Bot API token for delivery. Keep the client ID, app origin, token and webhook secret consistent between the API and worker environments. Never print Bot API URLs containing tokens or complete provider responses.

While signed in, users explicitly enable **Telegram alerts** in the Watchlist KOL tab. This starts `openid profile telegram:bot_access` consent with nonce, PKCE, browser and current-session binding. A different Telegram account is rejected without changing the Kollens login or favorites. The signed numeric profile `id` is stored separately from opaque OIDC `sub` and becomes the destination chat ID. The worker must send an activation confirmation successfully before alerts become enabled. Cancellation or delivery failure leaves a reconnect state.

For an authorized production release, register `https://kollens.com/api/telegram/webhook` using Telegram's `setWebhook` method with the configured `secret_token` and `allowed_updates` containing `message` and `my_chat_member`. Use a private server administration script that reads secrets from the environment; do not place a credential-bearing command in shell history or deploy output. The app never automatically registers or changes a webhook. A bot has one webhook: local tests must not replace the production webhook.

Private-chat `/stop` pauses alerts and cancels pending trade deliveries. `/start` and `/status` show connection status and a Watchlist link; they do not enable or resume alerts. Blocking the bot disables delivery and requires reconnection. Webhook requests require the configured secret header, and updates are durably deduplicated.

Only confirmed, live-observed trades by tracked, favorited KOLs qualify. Historical imports and repairs are silent. The first eligible trade is sent promptly; later trades from the same KOL are grouped into fixed ten-second summaries with buys and sells separated. Pending trades older than five minutes are skipped. Pausing, muting, unfollowing and side filters are rechecked before dispatch. Neither GMGN nor P&L/replay readiness is involved. Delivery respects per-chat and global pacing; provider cooldowns are retried, while an uncertain post-send response is retained for inspection instead of blindly duplicated.

## Local testing and release

After a successful ordinary login, accounts with inactive alerts see an optional invitation to enable or resume them. “Not now” dismisses it for that login; active accounts skip it. Messaging permission remains a separate explicit consent. The header Login button retains its appearance while sign-in starts.

The Watchlist KOL tab places followed KOLs on the left and Telegram settings on the right; settings move above the list on mobile. Radar filters stay separate. Trade messages use buy/sell emojis, bold names and values, linked token names and individual transaction times, and labelled navigation buttons. Formatting uses explicit [Telegram message entities](https://core.telegram.org/bots/api#messageentity), so token metadata is never interpreted as HTML or Markdown.

Use a separately registered HTTPS development origin, with its `/api/auth/telegram/callback` URL and matching `PUBLIC_APP_URL`. Use localhost only if BotFather explicitly accepts that callback. The development address must serve both the frontend and `/api` routes; do not point Telegram at the backend while browsing a different origin.

For local development, save `TELEGRAM_CLIENT_ID` and `TELEGRAM_CLIENT_SECRET` in the ignored `.env.telegram.local` file. `npm run dev:api` reads `.env` first and then `.env.telegram.local`; keep the development `PUBLIC_APP_URL` matched to the frontend origin. For example, if BotFather accepts it, use `http://127.0.0.1:5173` and register `http://127.0.0.1:5173/api/auth/telegram/callback`.

Run `npm run dev` and `npm run dev:api` with a private development database. With either Telegram credential absent, login remains disabled and guest stars still work. Automated tests use a signed test identity provider; a real Telegram approval still needs the dedicated bot and its registered callback. `npm run test:integration:auth` requires a disposable database named `bscan_auth_test` (or `bscan_auth_test_<number>`) and resets its public schema; never run it against application data.

Before enabling login live, verify a real approval, cancellation, return to the original page, guest merge, and access to the same token/KOL favorites in a second browser. Verify logout and guest behavior separately. Migrations are additive; take the normal database backup before deployment. Configure credentials on the VPS, then rebuild/restart through the standard release process.

Notification tests use an injected fake Bot API transport and a disposable integration database. Do not point notification test fixtures at application data. For a real local message check, explicitly opt in using a test account, approve fresh messaging consent and verify the activation before testing a newly confirmed trade. Production webhook registration and production delivery validation follow a separately authorized release. Keep the existing live webhook untouched during local development.

## Data and account behavior

The backend verifies Telegram identity before creating a local account. Telegram identity, favorites and preferences are stored in PostgreSQL; session secrets are hashed before storage. Account favorites do not expire when a device's 30-day login expires. Browser-only favorites retain the existing guest lifetime.

Telegram alert settings are separate from Radar filters. Alerts default off; once enabled, new favorite KOLs are included from their favorite time unless individually muted. Activation, resume and unmute boundaries prevent older trades from being delivered. Notification settings, verified chat IDs, update IDs and delivery evidence survive API/worker restarts. A reorg cancels pending orphaned trades and schedules corrections for already delivered messages. Operational metrics contain counts, timings and fixed failure categories, never tokens or complete message bodies.

Sign-in merges guest tokens and KOLs, preserving the account's existing filters. New accounts inherit guest filters. Each kind has a 100-item limit; an over-limit merge cancels login without modifying either list. Remove some guest or account favorites and retry. Clear Watchlist removes favorites and resets filters while keeping the current account signed in. Logout revokes only this device's login and starts an empty guest list; it does not erase account favorites.
