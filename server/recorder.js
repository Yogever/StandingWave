import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, RECORDINGS_DIR, STATE_FILE } from './config.js';

// Server-side recording engine.
//
// Each active recording is one ffmpeg process copying the HLS stream into a
// crash-safe MPEG-TS segment file. If the source hiccups and ffmpeg exits,
// we retry with a new segment file; on stop, all segments are concatenated
// and remuxed into a single .mp4 (falling back to keeping the .ts parts if
// the remux fails). Recordings survive browser disconnects by design and are
// bounded by RECORD_MAX_HOURS as a safety net.

const RETRY_DELAY_MS = 5000;
const RETRY_WINDOW_MS = 3 * 60 * 1000; // give a dropped source 3 minutes to come back
const STOP_GRACE_MS = 10000;

function tsStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export class Recorder {
  constructor(cameraStore) {
    this.cameraStore = cameraStore;
    this.active = new Map(); // cameraId -> job
  }

  listActive() {
    return [...this.active.values()].map((job) => ({
      cameraId: job.camera.id,
      cameraName: job.camera.name,
      city: job.camera.city,
      startedAt: job.startedAt,
      elapsedSec: Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000),
      state: job.state, // recording | reconnecting | stopping
      maxHours: config.recordMaxHours,
    }));
  }

  async start(camera) {
    if (this.active.has(camera.id)) {
      throw new Error(`already recording ${camera.name}`);
    }
    await this.cameraStore.ensureLive(camera);

    const base = `${camera.id}_${tsStamp()}`;
    const job = {
      camera,
      base,
      startedAt: new Date().toISOString(),
      segments: [],
      state: 'recording',
      proc: null,
      stopRequested: false,
      lastExitAt: 0,
      maxTimer: null,
      stopResolvers: [],
    };
    this.active.set(camera.id, job);
    this.persistState();

    job.maxTimer = setTimeout(
      () => this.stop(camera.id).catch(() => {}),
      config.recordMaxHours * 3600 * 1000,
    );
    job.maxTimer.unref();

    this.spawnSegment(job);
    return job;
  }

  spawnSegment(job) {
    const segPath = path.join(
      RECORDINGS_DIR,
      `${job.base}.part${job.segments.length}.ts`,
    );
    job.segments.push(segPath);

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '15',
      '-rw_timeout', '20000000',
      '-i', job.camera.streamUrl,
      '-c', 'copy',
      '-f', 'mpegts',
      segPath,
    ];
    // stdin stays open so we can send 'q' for a clean shutdown.
    const proc = spawn(config.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    job.proc = proc;
    job.state = 'recording';
    this.persistState();

    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    proc.on('exit', () => {
      job.proc = null;
      if (job.stopRequested) {
        this.finalize(job).catch((err) =>
          console.error(`[recorder] finalize failed for ${job.base}:`, err),
        );
        return;
      }
      console.warn(
        `[recorder] ffmpeg exited unexpectedly for ${job.camera.name}. ffmpeg said: ${stderrTail.slice(-400)}`,
      );
      job.firstDropAt = job.firstDropAt || Date.now();
      this.scheduleRetry(job);
    });
  }

  /** Source dropped: keep retrying for RETRY_WINDOW_MS, then give up and finalize. */
  scheduleRetry(job) {
    if (Date.now() - job.firstDropAt > RETRY_WINDOW_MS) {
      console.error(
        `[recorder] source for ${job.camera.name} gone > ${RETRY_WINDOW_MS / 60000} min, finalizing what we have`,
      );
      job.stopRequested = true;
      this.finalize(job).catch(() => {});
      return;
    }
    job.state = 'reconnecting';
    setTimeout(async () => {
      if (job.stopRequested) {
        this.finalize(job).catch(() => {});
        return;
      }
      try {
        await this.cameraStore.ensureLive(job.camera);
        job.firstDropAt = undefined; // stream is back
        this.spawnSegment(job);
      } catch {
        this.scheduleRetry(job);
      }
    }, RETRY_DELAY_MS).unref();
  }

  async stop(cameraId) {
    const job = this.active.get(cameraId);
    if (!job) throw new Error('no active recording for this camera');
    if (job.stopRequested) return this.waitForStop(job);

    job.stopRequested = true;
    job.state = 'stopping';
    clearTimeout(job.maxTimer);

    if (job.proc) {
      try {
        job.proc.stdin.write('q'); // clean ffmpeg shutdown
      } catch {
        job.proc.kill();
      }
      const proc = job.proc;
      setTimeout(() => {
        if (job.proc === proc) proc.kill();
      }, STOP_GRACE_MS).unref();
    } else {
      // Between retries — no process to stop, finalize directly.
      this.finalize(job).catch(() => {});
    }
    return this.waitForStop(job);
  }

  waitForStop(job) {
    return new Promise((resolve, reject) => {
      job.stopResolvers.push({ resolve, reject });
    });
  }

  async finalize(job) {
    if (job.finalized) return;
    job.finalized = true;
    this.active.delete(job.camera.id);
    this.persistState();
    try {
      const result = await finalizeSegments(job.base, job.segments, {
        camera: job.camera,
        startedAt: job.startedAt,
      });
      for (const { resolve } of job.stopResolvers) resolve(result);
      return result;
    } catch (err) {
      for (const { reject } of job.stopResolvers) reject(err);
      throw err;
    }
  }

  persistState() {
    const state = [...this.active.values()].map((job) => ({
      cameraId: job.camera.id,
      base: job.base,
      startedAt: job.startedAt,
      segments: job.segments,
      ffmpegPid: job.proc?.pid ?? null,
    }));
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }

  /** On boot: recordings that were active when the server died get salvaged. */
  async recoverOrphans() {
    let state = [];
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      return;
    }
    for (const orphan of state) {
      // If the server died but ffmpeg survived, it is still writing the
      // segment — stop it before finalizing.
      if (orphan.ffmpegPid) {
        try {
          process.kill(orphan.ffmpegPid);
          await new Promise((r) => setTimeout(r, 2000));
        } catch {
          /* already gone */
        }
      }
      const camera = this.cameraStore.get(orphan.cameraId) || {
        id: orphan.cameraId,
        name: orphan.cameraId,
        city: '',
        pageUrl: '',
      };
      console.warn(`[recorder] salvaging orphaned recording ${orphan.base}`);
      try {
        await finalizeSegments(orphan.base, orphan.segments, {
          camera,
          startedAt: orphan.startedAt,
          note: 'recovered after server restart',
        });
      } catch (err) {
        console.error(`[recorder] could not salvage ${orphan.base}:`, err.message);
      }
    }
    fs.writeFileSync(STATE_FILE, '[]');
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`)),
    );
  });
}

async function finalizeSegments(base, segments, meta) {
  const existing = segments.filter((s) => {
    try {
      return fs.statSync(s).size > 0;
    } catch {
      return false;
    }
  });
  // Clean up empty segment files.
  for (const s of segments) {
    if (!existing.includes(s)) fs.rmSync(s, { force: true });
  }
  if (existing.length === 0) throw new Error('no video data was captured');

  const finalPath = path.join(RECORDINGS_DIR, `${base}.mp4`);
  try {
    if (existing.length === 1) {
      await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y',
        '-i', existing[0], '-c', 'copy', '-movflags', '+faststart', finalPath]);
    } else {
      const listFile = path.join(RECORDINGS_DIR, `${base}.concat.txt`);
      fs.writeFileSync(
        listFile,
        existing.map((s) => `file '${s.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'),
      );
      await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-movflags', '+faststart', finalPath]);
      fs.rmSync(listFile, { force: true });
    }
    for (const s of existing) fs.rmSync(s, { force: true });
  } catch (err) {
    // Remux failed — keep the raw .ts so no footage is lost.
    console.error(`[recorder] remux failed, keeping raw segments: ${err.message}`);
    if (existing.length === 1) {
      const tsPath = path.join(RECORDINGS_DIR, `${base}.ts`);
      fs.renameSync(existing[0], tsPath);
      return writeMeta(tsPath, base, meta);
    }
    return writeMeta(existing[0], base, meta);
  }
  return writeMeta(finalPath, base, meta);
}

function writeMeta(filePath, base, meta) {
  const stat = fs.statSync(filePath);
  const endedAt = new Date().toISOString();
  const record = {
    file: path.basename(filePath),
    camera: meta.camera.name,
    city: meta.camera.city,
    cameraId: meta.camera.id,
    // Attribution kept with every saved file (see README legal note).
    source: 'opencctv.org',
    sourcePage: meta.camera.pageUrl,
    startedAt: meta.startedAt,
    endedAt,
    durationSec: Math.max(0, Math.floor((Date.parse(endedAt) - Date.parse(meta.startedAt)) / 1000)),
    sizeBytes: stat.size,
    ...(meta.note ? { note: meta.note } : {}),
  };
  fs.writeFileSync(`${filePath}.json`, JSON.stringify(record, null, 2));
  return record;
}
