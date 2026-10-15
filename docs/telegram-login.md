# Telegram login setup

Telegram login is optional. Visitors can follow tokens and KOLs without an account. Logged-in favorites and filter preferences persist across devices; logging out does not delete them.

## Configure the dedicated bot

1. Create a dedicated **Kollens Login** bot in [BotFather](https://t.me/BotFather), using the Kollens name and logo.
2. Open the bot's **Login Widget** settings. Register the production callback exactly as `https://kollens.com/api/auth/telegram/callback`. Register any separate development callback too; Telegram redirects only to allowed URLs.
3. Obtain the **Client ID** and **Client Secret** from those settings. These OIDC credentials are separate from the Bot API token. Keep the default RS256 signing algorithm; login requests `openid profile`, without phone or messaging access.
4. Put credentials in the private server `.env`:

   ```dotenv
   PUBLIC_APP_URL=https://kollens.com
   TELEGRAM_CLIENT_ID=your-client-id
   TELEGRAM_CLIENT_SECRET=your-client-secret
   ```

Do not prefix credentials with `VITE_`, add them to frontend configuration, paste them into chat, or commit them. The ignored `.env` stays on its host. Compose passes the two credentials to `app` only. The application uses Telegram's [documented OpenID Connect flow](https://core.telegram.org/bots/telegram-login); no webhook or message-delivery bot setup is required.

## Local testing and release

Use a separately registered HTTPS development origin, with its `/api/auth/telegram/callback` URL and matching `PUBLIC_APP_URL`. Use localhost only if BotFather explicitly accepts that callback. The development address must serve both the frontend and `/api` routes; do not point Telegram at the backend while browsing a different origin.

For local development, save `TELEGRAM_CLIENT_ID` and `TELEGRAM_CLIENT_SECRET` in the ignored `.env.telegram.local` file. `npm run dev:api` reads `.env` first and then `.env.telegram.local`; keep the development `PUBLIC_APP_URL` matched to the frontend origin. For example, if BotFather accepts it, use `http://127.0.0.1:5173` and register `http://127.0.0.1:5173/api/auth/telegram/callback`.

Run `npm run dev` and `npm run dev:api` with a private development database. With either Telegram credential absent, login remains disabled and guest stars still work. Automated tests use a signed test identity provider; a real Telegram approval still needs the dedicated bot and its registered callback. `npm run test:integration:auth` requires a disposable database named `bscan_auth_test` (or `bscan_auth_test_<number>`) and resets its public schema; never run it against application data.

Before enabling login live, verify a real approval, cancellation, return to the original page, guest merge, and access to the same token/KOL favorites in a second browser. Verify logout and guest behavior separately. Migrations are additive; take the normal database backup before deployment. Configure credentials on the VPS, then rebuild/restart `app` through the standard release process. No worker credential or Telegram messaging permission is needed.

## Data and account behavior

The backend verifies Telegram identity before creating a local account. Telegram identity, favorites and preferences are stored in PostgreSQL; session secrets are hashed before storage. Account favorites do not expire when a device's 30-day login expires. Browser-only favorites retain the existing guest lifetime.

Sign-in merges guest tokens and KOLs, preserving the account's existing filters. New accounts inherit guest filters. Each kind has a 100-item limit; an over-limit merge cancels login without modifying either list. Remove some guest or account favorites and retry. Clear Watchlist removes favorites and resets filters while keeping the current account signed in. Logout revokes only this device's login and starts an empty guest list; it does not erase account favorites.
