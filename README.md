# Pet Simulator Clans SPA

> [!IMPORTANT]
> **Maintenance status:** this project is not actively maintained. The hosted
> site and API are provided on a best-effort basis with no uptime, support, or
> response-time guarantee. Issues and pull requests may not be reviewed.

This repository contains a static single-page JavaScript application for
GitHub Pages and a Cloudflare Worker backed by D1.

- Live site: <https://andreyondemand.github.io/PSClans-SPA/>
- Public Worker: <https://psclans-spa.cloudflare-6apm0.workers.dev>

## Local verification

Node.js 24 is the documented development version; Node.js 22.13 or later is
supported (the scheduler tests use built-in SQLite). Install exactly the
dependency versions in `package-lock.json` and run the same checks used by CI:

```bash
npm ci
npm run check
npm test
npm run worker:dry-run
```

`npm run worker:dev` starts a local Worker with scheduled-event testing
enabled. D1 operations are local by default.

## Deploy on GitHub Pages

1. Push this branch to GitHub.
2. In repository settings, open **Pages**.
3. Set **Build and deployment** source to **Deploy from a branch**.
4. Choose branch `main` (or your deploy branch) and folder `/ (root)`.
5. Save.

GitHub Pages will host `index.html` and the SPA routes under hash URLs.

## Routes

- `#/` home
- `#/clans` clans table
- `#/clan?clan=CLAN_NAME` clan details
- `#/players?clan=CLAN_NAME&battleID=BATTLE_ID` battle players
- `#/enchants` enchants list

## Legacy URL compatibility

These redirect to the SPA route equivalents:

- `clans.html`
- `clan.html`
- `players.html`
- `enchants.html`

## Data Source

The SPA now uses live API communication with request throttling and TTL caching:

- Worker API (`https://psclans-spa.cloudflare-6apm0.workers.dev`)
  - `/health`
  - `/message`
  - `/pinned`
  - `/clans`
  - `/changes?clan=...`
  - `/clan?clan=...`
  - `/usernames?clan=...`
- Big Games API
  - `/activeClanBattle`
  - `/clans`
  - `/clan/:name`
  - `/collection/enchants`
- RoProxy (CORS-safe Roblox mirror)
  - `/v1/assets` thumbnails for clan/enchant icons
  - `/v1/users/avatar-headshot` user avatars
  - `/v1/users/:id` fallback username lookup

Client-side behavior to reduce API volume:

- Worker calls are rate-limited on the client.
- Responses are cached in memory and `localStorage` with per-endpoint TTLs.
- In-flight requests are deduplicated so concurrent views reuse the same request.

## Data lifecycle and external dependencies

- The Worker runs every minute and processes at most two clans per invocation.
  The persisted clan order stays fixed for a full rotation. Leaderboard refresh
  and username-cache cleanup use a separate invocation between rotations:
  65 tracked clans take about 34 minutes to cover under normal conditions.
- Each clan's snapshot, membership changes and next cursor commit together in
  D1. An interrupted run resumes at the first uncommitted clan. Unavailable
  upstream clans are skipped until the next rotation; a batch with no usable
  updates reports an error. Maintenance alone does not refresh health success.
- Scheduled upstream requests have shorter timeout/retry budgets, and a run
  stops starting more clans after 40 seconds of elapsed time. This bounds work
  during upstream trouble; it does not measure or guarantee CPU usage.
- A tracked battle's D1 history is deleted 24 hours after its advertised finish
  time. During the gap before another active battle, `/clans` can legitimately
  return an empty array and clan history can return `404`.
- `/health` distinguishes a healthy idle period from a stale or failed
  scheduler.
- The application depends on GitHub Pages, Cloudflare Workers and D1, BIG Games,
  Roblox, RoProxy, cdnjs, and jsDelivr. Changes or outages in any of those
  services can reduce functionality without a repository change.

## Worker deployment

The Worker requires a Cloudflare D1 database bound as `D1_DB`. The checked-in
`wrangler.jsonc` targets the existing production database, rate limiter,
Analytics Engine dataset, and one-minute cron.

### API request analytics

Every HTTP request emits a structured `api_request` event to Workers Logs and a
data point to the `psclans_api_requests` Analytics Engine dataset. Requests with
the exact browser `Origin` `https://andreyondemand.github.io` are classified as
`website`; all other requests are classified as `api`. Origin headers can be
spoofed, so this classification is useful for traffic analytics, not access
control.

The Analytics Engine columns are:

- `blob1` source (`website` or `api`)
- `blob2` path
- `blob3` origin (`none` when the header is absent)
- `blob4` country
- `blob5` HTTP method
- `blob6` response status
- `double1` request count (`1`)
- `double2` response duration in milliseconds

For a quick dashboard view, open the Worker's **Observability** page, filter
custom logs to `event = api_request`, select **Count**, and group by `source`.
Group by `path`, `country`, or `origin` for additional breakdowns.

Analytics Engine retains a longer queryable series. This query returns the
percentage of website and direct API traffic over the last seven days while
accounting for Analytics Engine sampling:

```sql
SELECT
  round(100 * sumIf(_sample_interval, blob1 = 'website') / sum(_sample_interval), 2)
    AS website_percent,
  round(100 * sumIf(_sample_interval, blob1 = 'api') / sum(_sample_interval), 2)
    AS api_percent
FROM psclans_api_requests
WHERE timestamp >= NOW() - INTERVAL '7' DAY
```

> [!CAUTION]
> The root Wrangler configuration points at production. Do not run `--remote`,
> migration, deployment, rollback, or deletion commands unless you are the
> authorized operator and have intentionally selected that target.

For an authorized production deployment:

1. Run `npm ci`, `npm run check`, `npm test`, and
   `npm run worker:dry-run`.
2. Export a recoverable D1 backup outside the repository or under the ignored
   `backups/` directory:

   ```bash
   mkdir -p backups
   npx wrangler d1 export psclans-spa --remote --output backups/pre-deploy.sql
   ```

3. Review and apply pending migrations:

   ```bash
   npx wrangler d1 migrations list psclans-spa --remote
   npx wrangler d1 migrations apply psclans-spa --remote
   ```

4. Deploy the already-validated bundle with `npm run worker:deploy`.
5. Verify `/health`, `/message`, `/clans`, and a known clan page after the next
   scheduled interval. Use `npx wrangler tail --status error` when health is
   degraded.

For an independent deployment, create a D1 database with
`npx wrangler d1 create psclans-spa` and replace the database ID in
`wrangler.jsonc` before applying migrations.

The initial migration creates the snapshot, membership-change, tracked-clan,
battle-state, and username-cache tables used by `API/spa-api.js`. Later
migrations add operational health state.

GitHub Actions runs the syntax checks, Worker regression tests, and Wrangler dry
run on every pull request and push to `main`. Dependabot checks npm and GitHub
Actions dependencies monthly.

Account-level protections are not encoded by this repository. An operator who
keeps the hosted service online should also:

- require the `CI / verify` check before merging to `main`;
- enable GitHub private vulnerability reporting;
- monitor `/health` at an interval well below its 20-minute freshness window;
- configure Cloudflare usage notifications or spending controls appropriate to
  the account.

## Security

See [`SECURITY.md`](./SECURITY.md). There is no guaranteed security-response
window for this maintenance-mode project. Do not publish exploit details or
credentials in a public issue.

## License

Code in this repository is licensed under **GNU AGPL-3.0-or-later**.
See [`LICENSE`](./LICENSE).

## Third-party Assets and APIs

- Files under `assets/images` are third-party assets and are not authored by this project.
  They are not covered by the AGPL code license unless a specific asset says otherwise.
- The Pet Simulator 99 public API is provided by **BIG Games LLC**.
  Reference: <https://github.com/BIG-Games-LLC/ps99-public-api-docs>
  This project is not affiliated with BIG Games LLC; API use must follow their terms and policies.

See [`THIRD_PARTY.md`](./THIRD_PARTY.md) for attribution and scope details.
