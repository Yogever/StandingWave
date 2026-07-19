/* StandingWave frontend — camera picker, live HLS preview, record control. */

const $ = (id) => document.getElementById(id);

// Cities shown in the sidebar by default; the rest hide behind their chips.
const DEFAULT_CITIES = ['Tel Aviv', 'Herzliya'];
const CITY_FILTER_KEY = 'sw.visibleCities';

function loadVisibleCities() {
  try {
    const saved = JSON.parse(localStorage.getItem(CITY_FILTER_KEY));
    if (Array.isArray(saved) && saved.length) return new Set(saved);
  } catch {
    /* fall through to default */
  }
  return new Set(DEFAULT_CITIES);
}

const state = {
  cameras: [],
  selectedId: null,
  active: [], // active recordings from the server
  hls: null,
  maxHours: 4,
  visibleCities: loadVisibleCities(),
};

function visibleCameras() {
  return state.cameras.filter((c) => state.visibleCities.has(c.city));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/* ── Sidebar ── */

function renderCityFilter() {
  const box = $('cityFilter');
  box.innerHTML = '';
  const cities = [...new Set(state.cameras.map((c) => c.city))];
  for (const city of cities) {
    const chip = document.createElement('button');
    chip.className = 'city-chip' + (state.visibleCities.has(city) ? ' on' : '');
    chip.textContent = city;
    chip.addEventListener('click', () => {
      if (state.visibleCities.has(city)) state.visibleCities.delete(city);
      else state.visibleCities.add(city);
      localStorage.setItem(CITY_FILTER_KEY, JSON.stringify([...state.visibleCities]));
      renderCityFilter();
      renderCameraList();
    });
    box.appendChild(chip);
  }
}

function renderCameraList() {
  const list = $('cameraList');
  list.innerHTML = '';
  for (const cam of visibleCameras()) {
    const item = document.createElement('div');
    item.className = 'camera-item';
    if (cam.id === state.selectedId) item.classList.add('active');
    if (cam.status === 'offline') item.classList.add('offline');

    const recording = isRecording(cam.id);
    const dotClass = recording
      ? 'recording'
      : cam.status === 'live'
        ? 'live'
        : cam.status === 'offline'
          ? 'offline'
          : '';

    const sub = [cam.city, cam.note, cam.status === 'offline' ? 'offline' : null]
      .filter(Boolean)
      .join(' · ');

    item.innerHTML = `
      <div class="camera-item-row">
        <div class="dot ${dotClass}"></div>
        <span class="name"></span>
      </div>
      <div class="sub"></div>`;
    item.querySelector('.name').textContent = cam.name;
    item.querySelector('.sub').textContent = sub;
    item.addEventListener('click', () => selectCamera(cam.id));
    list.appendChild(item);
  }
}

function isRecording(cameraId) {
  return state.active.some((r) => r.cameraId === cameraId);
}

/* ── Player ── */

function stopPlayback() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  const video = $('player');
  video.pause();
  video.removeAttribute('src');
  video.classList.add('hidden');
  $('placeholder').style.display = 'flex';
  $('liveBadge').classList.remove('on');
}

function startPlayback(cam) {
  const video = $('player');
  const showVideo = () => {
    video.classList.remove('hidden');
    $('placeholder').style.display = 'none';
    $('liveBadge').classList.add('on');
  };
  const src = cam.playUrl || cam.streamUrl;
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveDurationInfinity: true });
    state.hls = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      showVideo();
    });
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) {
        stopPlayback();
        setPlaceholder(`stream error · ${cam.name}`);
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    video.play().catch(() => {});
    showVideo();
  } else {
    setPlaceholder('HLS not supported in this browser');
  }
}

function setPlaceholder(text) {
  $('placeholderText').textContent = text;
}

/* ── Selection ── */

function selectedCamera() {
  return state.cameras.find((c) => c.id === state.selectedId) || null;
}

async function selectCamera(id) {
  state.selectedId = id;
  const cam = selectedCamera();
  if (!cam) return;

  $('camTitle').textContent = cam.name;
  $('camCity').textContent = cam.city + (cam.note ? ` · ${cam.note}` : '');
  renderCameraList();
  updateRecordBar();

  stopPlayback();
  if (cam.streamUrl && cam.status !== 'offline') {
    setPlaceholder(`connecting · ${cam.name}`);
    startPlayback(cam);
  } else {
    setPlaceholder(`offline · ${cam.name}, ${cam.city}`);
  }
}

/* ── Recording ── */

function fmtElapsed(sec) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec / 60) % 60))}:${p(Math.floor(sec % 60))}`;
}

function updateRecordBar() {
  const cam = selectedCamera();
  const btn = $('recordBtn');
  const label = $('recordBtnLabel');
  const rec = cam ? state.active.find((r) => r.cameraId === cam.id) : null;

  btn.disabled = !cam || (!rec && cam.status === 'offline');

  if (rec) {
    btn.classList.add('recording');
    label.textContent = 'Stop Recording';
    $('timer').textContent = fmtElapsed(rec.elapsedSec);
    $('timerSub').textContent = `${rec.state} · server-side · max ${rec.maxHours}h`;
  } else {
    btn.classList.remove('recording');
    label.textContent = 'Start Recording';
    $('timer').textContent = '00:00:00';
    const others = state.active.length;
    $('timerSub').textContent =
      (others ? `${others} other recording${others > 1 ? 's' : ''} running · ` : 'idle · ') +
      `server-side · max ${state.maxHours}h`;
  }
}

async function toggleRecording() {
  const cam = selectedCamera();
  if (!cam) return;
  const btn = $('recordBtn');
  btn.disabled = true;
  try {
    if (isRecording(cam.id)) {
      $('recordBtnLabel').textContent = 'Stopping…';
      const { file } = await api('/api/record/stop', {
        method: 'POST',
        body: JSON.stringify({ cameraId: cam.id }),
      });
      showSavedToast(file);
      if ($('autoDownload').checked) triggerDownload(file.url, file.file);
    } else {
      $('recordBtnLabel').textContent = 'Starting…';
      await api('/api/record/start', {
        method: 'POST',
        body: JSON.stringify({ cameraId: cam.id }),
      });
    }
  } catch (err) {
    showToast({ title: 'Recording error', meta: err.message, error: true });
  } finally {
    btn.disabled = false;
    await refreshActive();
    await refreshCameras();
  }
}

/* ── Toasts ── */

function fmtBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec / 60) % 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(Math.floor(sec % 60)).padStart(2, '0')}s`;
  return `${sec}s`;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function showSavedToast(file) {
  showToast({
    title: `Saved · ${file.camera}, ${file.city}`,
    meta: `${file.file} · ${fmtDuration(file.durationSec)} · ${fmtBytes(file.sizeBytes)}`,
    link: { href: file.url, label: 'Download ↓' },
  });
}

function showToast({ title, meta, link, error }) {
  const toasts = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `
    <div class="toast-title"></div>
    <div class="toast-meta"></div>
    <div class="toast-actions">
      ${link ? '<a class="toast-link"></a>' : ''}
      <button class="toast-dismiss">Dismiss</button>
    </div>`;
  el.querySelector('.toast-title').textContent = title;
  el.querySelector('.toast-meta').textContent = meta || '';
  if (link) {
    const a = el.querySelector('.toast-link');
    a.href = link.href;
    a.textContent = link.label;
  }
  el.querySelector('.toast-dismiss').addEventListener('click', () => el.remove());
  toasts.appendChild(el);
  if (error) setTimeout(() => el.remove(), 15000);
}

/* ── Recordings library ── */

function openLibrary() {
  $('libraryModal').classList.remove('hidden');
  refreshLibrary();
}

function closeLibrary() {
  $('libraryModal').classList.add('hidden');
  const p = $('libraryPlayer');
  p.pause();
  p.removeAttribute('src');
  p.load();
  p.classList.add('hidden');
}

async function refreshLibrary() {
  const list = $('libraryList');
  list.innerHTML = '<div class="lib-empty">Loading…</div>';
  let recs;
  try {
    recs = await api('/api/recordings');
  } catch (err) {
    list.innerHTML = '';
    showToast({ title: 'Could not load recordings', meta: err.message, error: true });
    return;
  }
  if (!recs.length) {
    list.innerHTML = '<div class="lib-empty">No recordings yet</div>';
    return;
  }
  list.innerHTML = '';
  for (const r of recs) {
    const row = document.createElement('div');
    row.className = 'lib-row';
    row.innerHTML = `
      <div class="lib-info">
        <div class="lib-name"></div>
        <div class="lib-meta"></div>
      </div>
      <div class="lib-actions">
        <button class="lib-btn" data-act="play">Play</button>
        <a class="lib-btn" data-act="download" download>Download ↓</a>
        <button class="lib-btn danger" data-act="delete">Delete</button>
      </div>`;
    row.querySelector('.lib-name').textContent = `${r.camera} · ${r.city}`;
    const date = new Date(r.startedAt).toLocaleString();
    row.querySelector('.lib-meta').textContent =
      `${date} · ${fmtDuration(r.durationSec)} · ${fmtBytes(r.sizeBytes)}`;
    row.querySelector('[data-act="download"]').href =
      `/recordings/${encodeURIComponent(r.file)}`;
    row.querySelector('[data-act="play"]').addEventListener('click', () => playInLibrary(r));
    row.querySelector('[data-act="delete"]').addEventListener('click', () =>
      deleteRecording(r, row),
    );
    list.appendChild(row);
  }
}

function playInLibrary(r) {
  const p = $('libraryPlayer');
  p.src = `/media/${encodeURIComponent(r.file)}`;
  p.classList.remove('hidden');
  p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  p.play().catch(() => {});
}

async function deleteRecording(r, row) {
  if (!confirm(`Delete "${r.file}"?\nThis permanently removes the recording.`)) return;
  try {
    await api(`/api/recordings/${encodeURIComponent(r.file)}`, { method: 'DELETE' });
    row.remove();
    if (!$('libraryList').children.length) {
      $('libraryList').innerHTML = '<div class="lib-empty">No recordings yet</div>';
    }
    await refreshStorage().catch(() => {});
  } catch (err) {
    showToast({ title: 'Delete failed', meta: err.message, error: true });
  }
}

/* ── Polling ── */

async function refreshCameras() {
  const cameras = await api('/api/cameras');
  const prev = selectedCamera();
  state.cameras = cameras;
  renderCameraList();
  // If the selected camera's stream URL changed status, refresh the record bar.
  const cur = selectedCamera();
  if (cur && prev && cur.status !== prev.status) updateRecordBar();
}

async function refreshActive() {
  state.active = await api('/api/recordings/active');
  if (state.active.length) state.maxHours = state.active[0].maxHours;
  renderCameraList();
  updateRecordBar();
}

async function refreshStorage() {
  const s = await api('/api/storage');
  const usedGb = s.usedBytes / 1024 ** 3;
  const capGb = s.capBytes / 1024 ** 3;
  $('storageNums').textContent = `${usedGb.toFixed(1)} / ${capGb.toFixed(0)} GB`;
  $('storageFill').style.width = `${Math.min(100, (usedGb / capGb) * 100).toFixed(1)}%`;
  $('storageNote').textContent = `Auto-delete after ${s.retentionDays} days`;
}

/* ── Wiring ── */

$('recordBtn').addEventListener('click', toggleRecording);

$('recheckBtn').addEventListener('click', async () => {
  const cam = selectedCamera();
  if (!cam) return;
  setPlaceholder(`re-checking · ${cam.name}`);
  try {
    await api(`/api/cameras/${cam.id}/resolve`, { method: 'POST' });
  } catch (err) {
    showToast({ title: 'Stream unavailable', meta: err.message, error: true });
  }
  await refreshCameras();
  selectCamera(cam.id);
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

const AUTO_DL_KEY = 'sw.autoDownload';
$('autoDownload').checked = localStorage.getItem(AUTO_DL_KEY) === '1';
$('autoDownload').addEventListener('change', (e) => {
  localStorage.setItem(AUTO_DL_KEY, e.target.checked ? '1' : '0');
});

$('libraryBtn').addEventListener('click', openLibrary);
$('libraryClose').addEventListener('click', closeLibrary);
$('libraryModal').addEventListener('click', (e) => {
  if (e.target === $('libraryModal')) closeLibrary();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('libraryModal').classList.contains('hidden')) closeLibrary();
});

async function init() {
  await refreshActive().catch(() => {});
  await refreshCameras();
  renderCityFilter();
  await refreshStorage().catch(() => {});

  // Default selection: first visible live camera, else first visible camera.
  const visible = visibleCameras();
  const first = visible.find((c) => c.status === 'live') || visible[0] || state.cameras[0];
  if (first) selectCamera(first.id);

  setInterval(() => refreshActive().catch(() => {}), 2000);
  setInterval(() => refreshCameras().catch(() => {}), 60000);
  setInterval(() => refreshStorage().catch(() => {}), 60000);
}

init().catch((err) => console.error('init failed:', err));
