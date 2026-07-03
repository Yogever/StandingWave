import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  port: num('PORT', 8080),
  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: num('SESSION_DAYS', 7),
  dataDir: path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  recordMaxHours: num('RECORD_MAX_HOURS', 4),
  retentionDays: num('RETENTION_DAYS', 30),
  storageCapGb: num('STORAGE_CAP_GB', 50),
  // Honest UA for the polite scraper — opencctv.org robots.txt allows /cameras/ for generic agents.
  scrapeUserAgent:
    process.env.SCRAPE_USER_AGENT ||
    'StandingWave/0.1 (personal beach-cam recorder; single user)',
};

export const RECORDINGS_DIR = path.join(config.dataDir, 'recordings');
export const CAMERAS_FILE = path.join(config.dataDir, 'cameras.json');
export const STATE_FILE = path.join(config.dataDir, 'state.json');
export const SEED_CAMERAS_FILE = path.join(ROOT_DIR, 'config', 'cameras.json');

export function ensureDataDirs() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}
