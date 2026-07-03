import fs from 'node:fs';
import { config, CAMERAS_FILE, SEED_CAMERAS_FILE } from './config.js';

// Camera store: seeded from config/cameras.json, persisted (with resolved
// stream URLs and health status) to data/cameras.json.

const M3U8_RE = /https:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/;
const HEALTH_INTERVAL_MS = 15 * 60 * 1000;

export class CameraStore {
  constructor() {
    this.cameras = [];
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

  /** Re-scrape the opencctv camera page for the current .m3u8 URL. */
  async resolve(camera) {
    const res = await fetch(camera.pageUrl, {
      headers: { 'User-Agent': config.scrapeUserAgent },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`camera page returned HTTP ${res.status}`);
    const html = await res.text();
    const match = html.match(M3U8_RE);
    camera.streamUrl = match ? match[0] : null;
    camera.lastVerified = new Date().toISOString();
    if (!camera.streamUrl) camera.status = 'offline';
    this.save();
    return camera;
  }

  /** Check that the camera's HLS playlist responds. */
  async checkHealth(camera) {
    if (!camera.streamUrl) return false;
    try {
      const res = await fetch(camera.streamUrl, {
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
          camera.status = (await this.checkHealth(camera)) ? 'live' : 'offline';
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
