import fs from 'node:fs';
import path from 'node:path';
import { config, RECORDINGS_DIR } from './config.js';

// Storage usage + retention so the disk never silently fills up.
// Two limits, both configurable: RETENTION_DAYS (age) and STORAGE_CAP_GB (total).

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function listRecordingFiles() {
  return fs
    .readdirSync(RECORDINGS_DIR)
    .filter((f) => /\.(mp4|ts)$/.test(f))
    .map((f) => {
      const full = path.join(RECORDINGS_DIR, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, size: stat.size, mtimeMs: stat.mtimeMs };
    });
}

export function storageInfo() {
  // In-progress .part files count toward usage too.
  let used = 0;
  for (const f of fs.readdirSync(RECORDINGS_DIR)) {
    try {
      used += fs.statSync(path.join(RECORDINGS_DIR, f)).size;
    } catch {
      /* file vanished mid-scan */
    }
  }
  return {
    usedBytes: used,
    capBytes: config.storageCapGb * 1024 ** 3,
    retentionDays: config.retentionDays,
  };
}

function deleteRecording(file) {
  fs.rmSync(file.path, { force: true });
  fs.rmSync(`${file.path}.json`, { force: true });
  console.log(`[retention] deleted ${file.name}`);
}

// Finished recordings for the library UI: one entry per .json sidecar, newest
// first. In-progress .part/.ts captures have no sidecar yet, so they're skipped.
export function listRecordings() {
  const out = [];
  for (const f of fs.readdirSync(RECORDINGS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, f), 'utf8'));
      const stat = fs.statSync(path.join(RECORDINGS_DIR, meta.file)); // media still present?
      out.push({
        file: meta.file,
        camera: meta.camera,
        city: meta.city,
        source: meta.source,
        sourcePage: meta.sourcePage,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt,
        durationSec: meta.durationSec,
        sizeBytes: meta.sizeBytes ?? stat.size,
      });
    } catch {
      /* sidecar without its media, or malformed — skip */
    }
  }
  out.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return out;
}

// Delete one recording by filename (from the library UI). basename() strips any
// path components so a crafted name can't escape RECORDINGS_DIR. Returns whether
// the media file existed.
export function deleteRecordingByName(name) {
  const safe = path.basename(name);
  if (!/\.(mp4|ts)$/.test(safe)) throw new Error('not a recording file');
  const full = path.join(RECORDINGS_DIR, safe);
  const existed = fs.existsSync(full);
  fs.rmSync(full, { force: true });
  fs.rmSync(`${full}.json`, { force: true });
  if (existed) console.log(`[library] deleted ${safe}`);
  return existed;
}

export function retentionSweep() {
  const now = Date.now();
  const maxAgeMs = config.retentionDays * 24 * 60 * 60 * 1000;
  let files = listRecordingFiles();

  for (const f of files) {
    if (now - f.mtimeMs > maxAgeMs) deleteRecording(f);
  }

  // Enforce the total cap, oldest first.
  files = listRecordingFiles().sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((s, f) => s + f.size, 0);
  const cap = config.storageCapGb * 1024 ** 3;
  for (const f of files) {
    if (total <= cap) break;
    deleteRecording(f);
    total -= f.size;
  }
}

export function startRetentionLoop() {
  try {
    retentionSweep();
  } catch (err) {
    console.error('[retention] sweep failed:', err.message);
  }
  const timer = setInterval(() => {
    try {
      retentionSweep();
    } catch (err) {
      console.error('[retention] sweep failed:', err.message);
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}
