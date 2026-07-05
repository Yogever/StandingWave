import fs from 'node:fs';
import { config, CAMERAS_FILE, SEED_CAMERAS_FILE } from './config.js';

// Camera store: seeded from config/cameras.json, persisted (with resolved
// stream URLs and health status) to data/cameras.json.

const M3U8_RE = /https:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/;
const HEALTH_INTERVAL_MS = 15 * 60 * 1000;

const WAVEHUB_URL_API = 'https://www.wavehub.co.il/api/secure-hls-url';
const IPCAMLIVE_PLAYER = 'https://g1.ipcamlive.com/player/player.php';

export class CameraStore {
  constructor() {
    this.cameras = [];
    // Per-camera cookie jars for wavehub (cookieCheck + hlsSession cookies).
    // Kept out of the camera objects so they never hit data/cameras.json.
    this.jars = new Map();
  }

  load() {
    const seed = JSON.parse(fs.readFileSync(SEED_CAMERAS_FILE, 'utf8'));
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(CAMERAS_FILE, 'utf8'));
    } catch {
      /* first boot */
    }
    const savedById = new Map(saved.map((c) => [c.id, c]));
    // Seed file is the source of truth for which cameras exist and their
    // names/pages; runtime state (streamUrl, status) carries over.
    this.cameras = seed.map((c) => {
      const prev = savedById.get(c.id) || {};
      return {
        ...c,
        streamUrl: prev.streamUrl ?? c.streamUrl ?? null,
        status: prev.status ?? 'unknown',
        lastVerified: prev.lastVerified ?? null,
      };
    });
    this.save();
  }

  save() {
    fs.writeFileSync(CAMERAS_FILE, JSON.stringify(this.cameras, null, 2));
  }

  list() {
    return this.cameras;
  }

  get(id) {
    return this.cameras.find((c) => c.id === id) || null;
  }

  /** Re-resolve the camera's current .m3u8 URL from its provider. */
  async resolve(camera) {
    if (camera.provider === 'wavehub') {
      camera.streamUrl = await this.resolveWavehub(camera);
    } else if (camera.provider === 'ipcamlive') {
      camera.streamUrl = await this.resolveIpcamlive(camera);
    } else {
      camera.streamUrl = await this.resolveOpencctv(camera);
    }
    camera.lastVerified = new Date().toISOString();
    if (!camera.streamUrl) camera.status = 'offline';
    this.save();
    return camera;
  }

  /** Scrape the opencctv camera page for a literal .m3u8 URL. */
  async resolveOpencctv(camera) {
    const res = await fetch(camera.pageUrl, {
      headers: { 'User-Agent': config.scrapeUserAgent },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`camera page returned HTTP ${res.status}`);
    const html = await res.text();
    return html.match(M3U8_RE)?.[0] ?? null;
  }

  /** Ask wavehub's own frontend API for a signed (short-lived) HLS URL. */
  async resolveWavehub(camera) {
    const res = await fetch(`${WAVEHUB_URL_API}?path=${encodeURIComponent(camera.source)}`, {
      headers: { 'User-Agent': config.scrapeUserAgent },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`wavehub URL API returned HTTP ${res.status}`);
    const { hlsUrl } = await res.json();
    // New signature means the old HLS session is stale — start a fresh jar.
    this.jars.delete(camera.id);
    return hlsUrl || null;
  }

  /** Read stream host + id out of the ipcamlive player page for our alias. */
  async resolveIpcamlive(camera) {
    const res = await fetch(`${IPCAMLIVE_PLAYER}?alias=${encodeURIComponent(camera.alias)}`, {
      headers: { 'User-Agent': config.scrapeUserAgent },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`ipcamlive player returned HTTP ${res.status}`);
    const html = await res.text();
    const address = html.match(/var address = '([^']+)'/)?.[1];
    const streamid = html.match(/var streamid = '([^']+)'/)?.[1];
    if (!address || !streamid) return null;
    return `${address.replace(/^http:/, 'https:')}streams/${streamid}/stream.m3u8`;
  }

  /**
   * Fetch a wavehub URL with the camera's cookie jar. Their CDN answers the
   * first request with a cookie-check redirect and issues an hlsSession
   * cookie on the master playlist that segments require.
   */
  async wavehubFetch(camera, url) {
    const jar = this.jars.get(camera.id) || new Map();
    this.jars.set(camera.id, jar);
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const headers = { 'User-Agent': config.scrapeUserAgent };
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(target, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(';', 1)[0];
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, target).href;
        continue;
      }
      return res;
    }
    throw new Error('too many redirects from wavehub');
  }

  /** Check that the camera's HLS playlist responds. */
  async checkHealth(camera) {
    if (!camera.streamUrl) return false;
    try {
      const res =
        camera.provider === 'wavehub'
          ? await this.wavehubFetch(camera, camera.streamUrl)
          : await fetch(camera.streamUrl, {
              signal: AbortSignal.timeout(12000),
            });
      // Read a little of the body so we know it is a real playlist.
      const text = res.ok ? (await res.text()).slice(0, 64) : '';
      return res.ok && text.includes('#EXTM3U');
    } catch {
      return false;
    }
  }

  /**
   * Make sure a camera has a working stream URL, re-resolving from its
   * opencctv page when the cached URL is missing or dead.
   * Returns the camera with fresh status, or throws if unreachable.
   */
  async ensureLive(camera) {
    if (await this.checkHealth(camera)) {
      camera.status = 'live';
      camera.lastVerified = new Date().toISOString();
      this.save();
      return camera;
    }
    await this.resolve(camera);
    if (camera.streamUrl && (await this.checkHealth(camera))) {
      camera.status = 'live';
      this.save();
      return camera;
    }
    camera.status = 'offline';
    this.save();
    throw new Error(`stream for "${camera.name}" is offline or unavailable`);
  }

  /** Periodic background health sweep so the sidebar dots stay honest. */
  startHealthLoop() {
    const sweep = async () => {
      for (const camera of this.cameras) {
        try {
          if (!camera.streamUrl) await this.resolve(camera);
          let ok = await this.checkHealth(camera);
          if (!ok) {
            // Stale URL (wavehub signatures expire hourly) — re-resolve once.
            await this.resolve(camera);
            ok = await this.checkHealth(camera);
          }
          camera.status = ok ? 'live' : 'offline';
          camera.lastVerified = new Date().toISOString();
        } catch {
          camera.status = 'offline';
        }
        // Be polite to opencctv and the stream hosts.
        await new Promise((r) => setTimeout(r, 1500));
      }
      this.save();
    };
    sweep().catch(() => {});
    this.healthTimer = setInterval(() => sweep().catch(() => {}), HEALTH_INTERVAL_MS);
    this.healthTimer.unref();
  }
}
