# Pet Simulator Clans SPA

This repo serves a single-page JavaScript app that can be hosted for free on GitHub Pages.

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

- Worker API (`https://petsimulatorclansapi.andreybusinessacc6675.workers.dev`)
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
