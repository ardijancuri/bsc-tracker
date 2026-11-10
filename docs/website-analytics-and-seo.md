# Website analytics and search appearance

Kollens records daily public page views and estimated unique browsers when a visitor allows analytics. Days use Europe/Skopje time, including its daylight-saving changes.

## Enable and read analytics

Set `KOLLENS_ANALYTICS_ENABLED=true` for the app process when releasing this version. The default in Compose is disabled. This flag enables the endpoint, creates the two analytics tables, and makes the consent controls available. For the separate Vite development server, also set `VITE_KOLLENS_ANALYTICS_ENABLED=true`.

Read the last seven days from the running app container.

```sh
docker exec kollens-fresh-v14-app-1 npm run analytics:report -- --days 7
```

The command accepts 1–366 days and an optional `--json` argument. It reads the database without exposing reporting through a public endpoint. A local production build can use the same command with its local `DATABASE_URL`.

Analytics starts accumulating after activation and visitor consent. Earlier request logs cannot be converted into a distinct-visitor count.

## What the counts represent

- A page view is a visible visit to a public page, including navigation inside the app and browser Back. Auto-refreshes, changing filters and opening a modal keep the existing page view.
- A unique visitor is an opted-in browser on that Skopje calendar day. Several tabs share the same identifier. Different devices, browsers or cleared storage can count separately.
- Visitors who decline, enable Do Not Track or Global Privacy Control, block telemetry, or browse with storage unavailable are excluded. Recognized bots are also excluded.
- Portfolio, Watchlist, Creator account management, authentication, extension connection, invalid pages and the legacy private Watchlist view are excluded.

The client sends a random page-view ID, a daily random browser ID, and an allowlisted pathname to the same-origin endpoint. Query strings, URL fragments and account identifiers are excluded. Analytics storage contains hashes and counts, with no IP addresses, raw browser IDs, user agents or visited paths. Normal operational request logs are separate. Browsers with the Web Locks API coordinate daily identifier creation across concurrent tabs.

The two PostgreSQL tables have these purposes.

- `website_analytics_daily` retains one count row per day.
- `website_analytics_keys` deduplicates page views and browsers. Hourly cleanup retains only the current day and the preceding two calendar days.

Visitors can change their choice in Privacy Policy → Website analytics. Declining removes the daily browser identifier and stops subsequent reports from that browser. Aggregate historical counts remain.

## Search and link previews

The canonical homepage is `https://kollens.com/`. The existing `/trades` and `/index.html` URLs permanently redirect there. Internal navigation uses the canonical homepage.

Public pages receive their title, description, canonical URL, Open Graph and X preview metadata in the initial HTML. React updates the same tags during navigation. Named public token and KOL pages receive their own metadata through database identity reads, independent of chart and accounting preparation.

The homepage includes WebSite and Organization structured data. Other indexable public pages include breadcrumbs. A short description and navigation links are present before JavaScript runs.

`/sitemap.xml` is an index of separate sitemap files for public pages, KOLs and tokens. Token files contain up to 1,000 contracts each in stable address order. The result is coalesced and cached for five minutes. It excludes private and unknown identities. The current memory bound is 50,000 public detail pages. Exceeding it returns an explicit failure instead of silently dropping older entries, so that bound must be raised or the query partitioned before the site reaches it. Detail identity lookups use bounded caches and read-only database transactions with statement timeouts.

`/robots.txt` points crawlers to the sitemap and allows the API reads needed to render the app. API responses carry `X-Robots-Tag: noindex`. Private HTML pages advertise `noindex`, and missing pages return HTTP 404. Temporary database failures return HTTP 503 instead of publishing a false missing page.

After the release, verify `https://kollens.com` in Google Search Console and submit `https://kollens.com/sitemap.xml`. Use URL Inspection on the homepage and a known token or KOL page to check Google's rendered result.

## Local verification

Use an isolated database for browser and database tests. The implementation was checked with actual Chromium against the production build and a dedicated PostgreSQL database. Test reports and consent screenshots are in the ignored `.cache/analytics-seo-verification` directory.

Browser checks covered consent, withdrawal, concurrent tabs, browser Back, privacy signals, private routes, responsive layout, metadata and runtime errors. Separate database checks verified idempotent concurrent updates and key retention.
