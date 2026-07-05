import express from 'express';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config, ROOT_DIR, RECORDINGS_DIR, INTERNAL_TOKEN, ensureDataDirs } from './config.js';
import {
  isAuthenticated,
  makeSessionCookie,
  verifyPassword,
  checkLoginAllowed,
  recordLoginFailure,
  SESSION_COOKIE_NAME,
} from './auth.js';
import { CameraStore } from './cameras.js';
import { Recorder } from './recorder.js';
import { storageInfo, startRetentionLoop } from './storage.js';

if (!config.appPassword) {
  console.error('APP_PASSWORD is required. Set it in the environment or .env file.');
  process.exit(1);
}

ensureDataDirs();

const cameraStore = new CameraStore();
cameraStore.load();

const recorder = new Recorder(cameraStore);
await recorder.recoverOrphans();

cameraStore.startHealthLoop();
startRetentionLoop();

const app = express();
app.disable('x-powered-by');
app.use(express.json());

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// ── Unauthenticated surface: health check + login ──
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'styles.css')));

app.post('/api/login', (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkLoginAllowed(ip)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  if (!verifyPassword(req.body?.password ?? '')) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'wrong password' });
  }
  const cookie = makeSessionCookie();
  res.setHeader(
    'Set-Cookie',
    `${cookie.name}=${cookie.value}; Max-Age=${Math.floor(cookie.maxAgeMs / 1000)}; Path=/; HttpOnly; SameSite=Lax`,
  );
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

// ── Auth gate for everything else ──
app.use((req, res, next) => {
  if (isAuthenticated(req)) return next();
  // In-process ffmpeg recording through the local HLS proxy.
  if (req.headers['x-standingwave-internal'] === INTERNAL_TOKEN) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
});

app.use(express.static(PUBLIC_DIR));

// Browser-facing playback URL. Wavehub's CDN pins CORS to wavehub.co.il and
// wants per-session cookies, so those cameras play through our HLS proxy;
// everything else is fetched by hls.js straight from the source.
function playUrlFor(camera) {
  if (camera.provider === 'wavehub' && camera.streamUrl) {
    return `/hls/${encodeURIComponent(camera.id)}/index.m3u8`;
  }
  return camera.streamUrl;
}

// ── HLS proxy for wavehub cameras ──
// Playlists reference variants/segments relatively, so the browser and ffmpeg
// come back to /hls/:id/<file> and we map that onto the signed upstream URL.
app.get('/hls/:id/:file', async (req, res) => {
  const camera = cameraStore.get(req.params.id);
  if (!camera || camera.provider !== 'wavehub') {
    return res.status(404).json({ error: 'unknown camera' });
  }
  const fetchUpstream = () => {
    if (req.params.file === 'index.m3u8') {
      return cameraStore.wavehubFetch(camera, camera.streamUrl);
    }
    const base = camera.streamUrl.slice(0, camera.streamUrl.lastIndexOf('/') + 1);
    const query = req.originalUrl.split('?')[1];
    return cameraStore.wavehubFetch(camera, base + req.params.file + (query ? `?${query}` : ''));
  };
  try {
    if (!camera.streamUrl) await cameraStore.resolve(camera);
    let upstream = await fetchUpstream();
    if ([401, 403].includes(upstream.status) && req.params.file === 'index.m3u8') {
      // Signed URL expired — refresh it once and retry.
      await cameraStore.resolve(camera);
      upstream = await fetchUpstream();
    }
    res.status(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── API ──
app.get('/api/cameras', (_req, res) => {
  res.json(
    cameraStore.list().map((c) => ({
      ...c,
      playUrl: playUrlFor(c),
      recording: recorder.active.has(c.id),
    })),
  );
});

app.post('/api/cameras/:id/resolve', async (req, res) => {
  const camera = cameraStore.get(req.params.id);
  if (!camera) return res.status(404).json({ error: 'unknown camera' });
  try {
    await cameraStore.ensureLive(camera);
    res.json({ ...camera, playUrl: playUrlFor(camera) });
  } catch (err) {
    res.status(502).json({ error: err.message, camera });
  }
});

app.get('/api/recordings/active', (_req, res) => {
  res.json(recorder.listActive());
});

app.post('/api/record/start', async (req, res) => {
  const camera = cameraStore.get(req.body?.cameraId);
  if (!camera) return res.status(404).json({ error: 'unknown camera' });
  try {
    const job = await recorder.start(camera);
    res.json({ ok: true, cameraId: camera.id, startedAt: job.startedAt });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/record/stop', async (req, res) => {
  try {
    const record = await recorder.stop(req.body?.cameraId);
    res.json({
      ok: true,
      file: {
        ...record,
        url: `/recordings/${encodeURIComponent(record.file)}`,
      },
    });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.get('/api/storage', (_req, res) => {
  res.json(storageInfo());
});

// Direct download links (given out via the post-stop toast). Range requests
// supported so the files also stream in a <video> tag or VLC.
app.use(
  '/recordings',
  express.static(RECORDINGS_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.mp4') || filePath.endsWith('.ts')) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${path.basename(filePath)}"`,
        );
      }
    },
  }),
);

app.listen(config.port, () => {
  console.log(`StandingWave listening on http://localhost:${config.port}`);
  console.log(
    `  recordings: ${RECORDINGS_DIR}\n  retention: ${config.retentionDays} days / ${config.storageCapGb} GB cap\n  max recording length: ${config.recordMaxHours}h`,
  );
});
