# Build prompt for Claude Code (Fable 5)

Copy everything below into Claude Code.

---

## Project

Build "StandingWave" — a hosted web service (deployed on the internet, accessible from any browser) that lets me watch live public webcam feeds of Israeli beaches and save recordings on demand. It's for a single user (me) — no multi-tenant accounts needed — but because it's internet-reachable, it needs basic access protection so strangers can't use it or rack up my hosting/storage bill. I'll handle UI/visual design separately (Claude Design); focus on a clean, functional architecture with simple default views, not final polish.

## Data source: opencctv.org — read this before coding

opencctv.org is a directory site that aggregates public webcam feeds; it does **not** publish a documented public API. Before building, verify these assumptions against the live site and adjust the plan if they've changed:

- Camera pages follow the pattern `https://opencctv.org/cameras/israel/<region>/<city>/<slug>-<id>`. There's a country index at `https://opencctv.org/cameras/israel` (currently ~47 cameras, ~15-16 tagged "beach") and a general `https://opencctv.org/cameras/beach-cams` index.
- Each camera page exposes a "Feed Type" (e.g. `M3U8`), coordinates, category, and a "direct link" to the actual stream — in practice these are HLS `.m3u8` URLs hosted on **third-party** services (e.g. `s75.ipcamlive.com/streams/.../stream.m3u8`), not on opencctv's own servers. opencctv is just an aggregator/directory; the real video comes from whatever operator (ipcamlive, a municipality, a hotel, etc.) hosts it.
- opencctv also serves snapshot images at an internal endpoint (`opencctv.org/api/feed/<camera-key>?...`), used for OG images/thumbnails — treat this as unofficial and possibly signed/rate-limited.
- There is no bulk/JSON API confirmed publicly. Getting the list of Israeli beach cameras + their current stream URLs will likely require either (a) scraping the camera index and detail pages (respect robots.txt and reasonable rate limits), or (b) maintaining a small curated/manual list of beach cameras + stream URLs that gets refreshed periodically, since individual camera stream URLs can go stale or change.

**First task for you (Claude Code):** spend a short investigation pass confirming the current page structure, whether a robots.txt disallows scraping, and whether stream URLs are stable enough to cache vs. needing to be re-resolved from the camera page each time. Report back what you find before committing to an architecture, since this determines whether we need a scraper module or just a static config file.

### Legal/compliance note (flag, don't skip)

These streams are "publicly viewable," not "public domain" in the legal sense — the underlying footage is still owned by whoever operates each camera (municipality, business, etc.), and opencctv itself is just re-embedding them. Don't hardcode a "public domain" claim into the app. Instead:
- Add a short in-app disclaimer that recordings are for personal/archival use and that source attribution (camera name + opencctv.org link) is kept with each saved file.
- Make it easy to stop mirroring/remove a camera if a source ever asks (opencctv itself has a removal-request contact — treat the same courtesy toward source operators).
- Don't build anything that hides or spoofs the origin of the stream.

## Core features (MVP)

1. **Beach picker** — list of Israeli beach cameras (name + city, e.g. "Hilton Beach, Tel Aviv", "Bat Galim Beach, Haifa", "Meridian Beach, Haifa", "Aviv Beach (Dolfinarium), Tel Aviv"). Selecting one loads a live preview.
2. **Live preview** — play the HLS stream in-browser (e.g. via hls.js).
3. **Start/stop recording** — a clear record button per selected beach. Recording should run **server-side** and keep going even if I close the browser tab or lose my connection — stopping it should require an explicit stop action (from the UI, or it keeps recording until I come back and stop it, or hits a configurable max duration as a safety net). Show elapsed time and which beach is being captured while it runs.
4. **Recording storage** — save recordings as video files (e.g. via `ffmpeg -i <m3u8> -c copy output.mp4` segment capture) on persistent storage attached to the host (disk volume or object storage like S3-compatible storage — pick based on the hosting platform), named with beach name + timestamp. Handle stream drops/reconnects gracefully (don't corrupt the file or crash if the source hiccups).
5. **Recordings library** — a simple list/gallery of past recordings (beach, date, duration, file size) with play/delete/download actions, servable back over HTTP.
6. **Storage/retention awareness** — since this runs on a paid host indefinitely, add a configurable retention policy (e.g. auto-delete recordings older than N days, or a total-storage cap) so it doesn't silently fill the disk or run up costs. Surface current storage usage somewhere in the UI.
7. **Multiple concurrent recordings** (nice-to-have, not required for MVP) — allow recording more than one beach at once if feasible.

## Access protection

Single user, but internet-facing. Add a lightweight auth gate — a login/password (or a single shared secret token) in front of the whole app — so it's not open to anyone who finds the URL. Don't build out multi-user/roles/signup; just enough to keep it private to me.

## Suggested architecture (adjust if you find a better fit)

- A backend service (Node/Express or Python/FastAPI, your call) plus a simple frontend, deployed as a long-running hosted process — recording needs to keep running independent of any open browser connection, which rules out a purely serverless/static approach for the recording piece.
- ffmpeg as the recording engine, running as a background/managed process per active recording (confirm it's available on the target hosting platform, or containerize it so it is).
- Pick a hosting approach that supports: a long-running process, persistent storage across restarts/redeploys, and a way to serve saved video files back to the browser. Call out the options and tradeoffs (e.g. a small VPS/container platform with a disk volume, vs. a PaaS + object storage bucket for recordings) and recommend one rather than assuming I have a preference.
- A config file or small DB (SQLite/JSON) listing known Israeli beach cameras: name, city, coordinates, opencctv page URL, last-known stream URL, last-verified date. Include a small script/task to re-resolve stale stream URLs from the opencctv camera page.
- Keep the frontend components simple and swappable — I'll be restyling the UI separately, so avoid baking in specific visual design decisions; focus on functional structure, clear component boundaries, and sensible default styling.

## Explicit non-goals for this pass

- Final visual design/branding — coming from a separate design pass.
- Multi-user accounts, roles, or signup flows.
- Guaranteeing every opencctv Israeli beach camera works — some may be offline or have unstable feeds; handle failures gracefully rather than trying to guarantee full coverage.

## Deliverable

A working hosted service satisfying the MVP features above, plus a short README covering: how the beach camera list is sourced/refreshed, how to deploy/run it (including the access-protection secret), where recordings are stored, and how retention/storage limits are configured. Flag any assumptions you had to make about opencctv.org's structure, or about the hosting platform, so we can revisit them if needed.
