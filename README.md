# IP Lookup API

**Side project:** this repo was made to try things out and learn—not as a finished product. **Do not rely on it for production.** There is no promise of security reviews, uptime, scaling, or long-term maintenance.

---

HTTP API for IP geolocation using [MaxMind GeoIP2](https://dev.maxmind.com/geoip/docs/databases) MMDB databases (for example GeoLite2-City). The server is built with [Bun](https://bun.sh): it downloads and refreshes the database on a schedule, loads it with `@maxmind/geoip2-node`, and returns city-style GeoJSON-like records as JSON.

## Prerequisites

- [Bun](https://bun.sh) installed
- A MaxMind account with **Account ID** and **License Key** ([sign up](https://www.maxmind.com/en/geolite2/signup) for free GeoLite2)

## Setup

```bash
bun install
```

Copy `.env.example` to `.env` and set at least:

| Variable                       | Required | Description                                                               |
| ------------------------------ | -------- | ------------------------------------------------------------------------- |
| `MAXMIND_ACCOUNT_ID`           | Yes      | MaxMind account ID                                                        |
| `MAXMIND_LICENSE_KEY`          | Yes      | MaxMind license key                                                       |
| `PORT`                         | No       | HTTP port (default `3000`)                                                |
| `NODE_ENV`                     | No       | `development` or `production`                                             |
| `BASE_URL` / `PUBLIC_BASE_URL` | No       | Public base URL (e.g. for scripts; default `http://localhost:3000`)       |
| `DATA_DIR`                     | No       | Directory for the MMDB file (default `./data`)                            |
| `MAXMIND_EDITION_IDS`          | No       | Edition slug for the download permalink (default `GeoLite2-City`)         |
| `MAXMIND_MMDB_FILENAME`        | No       | Filename under `DATA_DIR` (default `GeoLite2-City.mmdb`)                  |
| `MAXMIND_DOWNLOAD_URL`         | No       | Full download URL; if set, overrides the permalink built from edition IDs |

## Run

Development (hot reload):

```bash
bun dev
```

Production-style:

```bash
bun start
```

On startup, the app tries to open the local MMDB. If the file is missing, the hourly sync may install it shortly afterward. Until the database is ready, lookup endpoints respond with `503` and `{ "error": "database not ready" }`.

## API

Endpoints, request/response bodies, and status codes: [docs/api.md](docs/api.md).

## MaxMind sync

`startMaxMindSyncHourly` runs an immediate sync and then every **60 minutes**. It:

1. Builds a download URL (explicit `MAXMIND_DOWNLOAD_URL` or permalink from `MAXMIND_EDITION_IDS`).
2. Probes `Last-Modified` with a small ranged GET to decide if a full download is needed.
3. Downloads the `.tar.gz`, extracts the `.mmdb`, and atomically replaces the target file under `DATA_DIR`.
4. Reloads the in-memory reader when a download succeeds.

If the local file is older than **7 days** and metadata probing fails, the code may still treat the file as stale; see `LOCAL_MAX_AGE_MS` and `shouldDownload` in [`src/sync.ts`](src/sync.ts).

## Scripts

| Command             | Description                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `bun test`          | Run tests                                                                                |
| `bun run lookup-me` | Resolve public IP via ipify, then call `GET /api/v1/ip-lookup?ip=...` against `BASE_URL` |

## Logging

Logs are one JSON object per line (`timestamp`, `level`, `message`, plus fields), suitable for ingestion pipelines such as Loki with a JSON parse stage.

## License

This project is private / unlicensed unless you add a license file. GeoLite2 and related MaxMind data are subject to [MaxMind’s terms](https://www.maxmind.com/en/legal).
