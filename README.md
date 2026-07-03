# StandingWave 🌊

A tiny self-hosted web app for watching live Israeli beach webcams and saving
recordings on demand. Single user, password-protected, records **server-side**
(closing the browser tab does not stop a recording).

Live feeds are sourced from [opencctv.org](https://opencctv.org), a directory
of publicly viewable webcams. The actual video comes from third-party stream
hosts (mostly `ipcamlive.com`).

## How it works

```
browser ──login──▶ Express server ──spawns──▶ ffmpeg (one per recording)
   │                    │                        │
   │  hls.js plays      │  data/cameras.json     ▼
   └─ stream direct     │  (resolved URLs)     data/recordings/*.mp4 (+ .json sidecar)
      from the host     └─ retention sweep ◀──── hourly
```

- **Camera list** — seeded from [`config/cameras.json`](config/cameras.json)
  (name, city, opencctv page URL). At runtime the server scrapes each camera's
  opencctv page for the current `.m3u8` stream URL and caches it in
  `data/cameras.json`. Stream URLs go stale; a health sweep re-checks every
  15 minutes, and any failure triggers a re-resolve from the camera page.
  There is also a "↻ recheck" button in the UI. To add/remove a camera, edit
  the seed file and restart.
- **Live preview** — the browser plays the HLS stream directly from the source
  host via hls.js (the hosts send permissive CORS headers, so no proxy is
  needed).
- **Recording** — the server spawns `ffmpeg -i <m3u8> -c copy` writing a
  crash-safe MPEG-TS file. If the source drops, it retries for up to 3 minutes
  and continues into a new segment; on stop, segments are concatenated and
  remuxed to a single `.mp4`. Every recording is capped at `RECORD_MAX_HOURS`
  (default 4h) as a safety net. Multiple cameras can record concurrently.
  If the server restarts mid-recording, the captured footage is salvaged into
  a finished file on boot.
- **Recordings on disk** — `data/recordings/<camera>_<timestamp>.mp4`, each
  with a `.json` sidecar carrying attribution (camera name, city, opencctv
  page URL), start/end time, duration, and size. When you stop a recording the
  UI shows a toast with a direct download link (`/recordings/<file>`, login
  required). There is deliberately no recordings-library UI.
- **Retention** — an hourly sweep deletes recordings older than
  `RETENTION_DAYS` (default 30) and, oldest-first, anything over
  `STORAGE_CAP_GB` (default 50). Current usage is shown in the sidebar.
- **Auth** — one shared password (`APP_PASSWORD`) gates everything except
  `/healthz`. Login sets an HMAC-signed, HttpOnly session cookie (7 days).
  Login attempts are rate-limited (10 per 15 min per IP).

## Run locally

Requirements: Node 20+, ffmpeg on `PATH` (or set `FFMPEG_PATH`).

```sh
npm install
cp .env .env        # set APP_PASSWORD
APP_PASSWORD=yourpassword npm start
# → http://localhost:8080
```

(On Windows PowerShell: `$env:APP_PASSWORD='yourpassword'; npm start`.)

## Run with Docker

```sh
cp .env .env        # set APP_PASSWORD
docker compose up -d --build
```

ffmpeg is baked into the image; recordings live in the `recordings` named
volume (`/data` in the container) and survive restarts/redeploys.

## Deploying (free hosting)

The app needs three things that rule out serverless/static hosts: a
long-running process (recordings continue with no browser attached), ffmpeg,
and persistent disk. Genuinely-free options, in order of recommendation:

1. **Oracle Cloud Always Free** (recommended) — up to 4 ARM OCPUs / 24 GB RAM
   / 200 GB block storage, free indefinitely. Plenty for many concurrent
   recordings. Create an Ubuntu ARM VM, install Docker, clone this repo,
   `docker compose up -d`. Caveats: signup can be picky, and ARM capacity in
   some regions requires retrying instance creation.
2. **Google Cloud e2-micro** (always-free tier) — 1 shared vCPU / 1 GB RAM /
   30 GB disk in `us-west1`/`us-central1`/`us-east1`. Since recording is
   stream-copy (no transcoding), 1 GB RAM handles a couple of concurrent
   recordings fine; the 30 GB disk means setting `STORAGE_CAP_GB` to ~20.
3. **A home machine / spare box** — free and simple if you have one running
   anyway; expose it via a tunnel (Cloudflare Tunnel, Tailscale Funnel) rather
   than opening ports.

Whatever the host, put the app behind HTTPS (Caddy or a Cloudflare Tunnel is
the least-effort path) — the login password travels in the request body.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `APP_PASSWORD` | — (required) | Shared password for the login page |
| `PORT` | `8080` | HTTP port |
| `RECORD_MAX_HOURS` | `4` | Auto-stop safety cap per recording |
| `RETENTION_DAYS` | `30` | Recordings older than this are deleted |
| `STORAGE_CAP_GB` | `50` | Total recordings cap (oldest deleted first) |
| `DATA_DIR` | `data` | Where cameras.json, state and recordings live |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary |
| `SESSION_DAYS` | `7` | Login session lifetime |
| `SESSION_SECRET` | derived from password | Override the cookie-signing key |

## Sourcing & legal

- opencctv.org's `robots.txt` **allows** crawling `/cameras/` pages (checked
  2026-07-03); the app scrapes only those pages, with an honest User-Agent and
  ~1.5 s spacing between requests, and does not touch their internal `/api/`
  endpoints (which robots.txt disallows).
- These streams are *publicly viewable*, not public domain. Footage belongs to
  whoever operates each camera. Recordings are for personal/archival use;
  attribution (camera name + opencctv page) is stored in each recording's
  `.json` sidecar and a disclaimer is shown in the UI. If a camera operator
  asks for removal, delete its entry from `config/cameras.json` — mirroring
  courtesy of opencctv's own removal-request policy.

## Assumptions to revisit

- Camera pages embed the `.m3u8` URL directly in server-rendered HTML (true as
  of 2026-07-03; if opencctv moves to client-side rendering the resolver's
  regex will stop matching).
- Stream hosts send `Access-Control-Allow-Origin: *` and need no Referer, so
  the browser plays them directly. If a source starts requiring headers, the
  preview would need a small HLS proxy through the backend (recording via
  ffmpeg would still work).
- Some directory entries don't expose an m3u8 at all (e.g. Banana Beach) —
  they'll simply show as offline in the sidebar.
- The design mock listed "Gordon Beach" and "Frishman Beach"; those don't
  exist on opencctv, so the seed list uses the ~12 real Israeli beach cams.
