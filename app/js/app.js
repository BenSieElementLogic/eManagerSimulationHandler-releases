// Live layer for the Spec 0008 dashboard: connects to the 0007 stats WebSocket, re-renders the KPI
// tiles / ports table / missions log on every push, and wires the controls (start/stop, worktime
// slider, demo seed, per-port open/close) to the 0007 control API. Plain ES module, no framework.
import {
  formatCount,
  formatDuration,
  formatThroughput,
  formatPercent,
  portStatusPill,
  missionStatePill,
  formatQuantity,
  missionActivities,
} from './format.js';

// --- in-browser bridge --------------------------------------------------------------------------
// This build runs the ENTIRE simulation in the browser via Blazor WebAssembly. Instead of REST + a
// ws/stats WebSocket, the data layer calls the C# SimBridge ([JSInvokable]) directly and polls a
// snapshot. Only these three functions (control/getStatus/apiGetJson) — plus connect() below —
// changed; every render function is untouched.
const ASM = 'EManagerSimulationHandler.Wasm';
const invoke = (method, ...args) => globalThis.DotNet.invokeMethodAsync(ASM, method, ...args);

function parse(json) {
  if (json == null) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function control(path, body) {
  return parse(await invoke('Control', path, body ? JSON.stringify(body) : null));
}

async function getStatus() {
  return parse(await invoke('GetJson', 'status', ''));
}

// --- KPI tiles ----------------------------------------------------------------------------------
const kpiFormatters = {
  totalPicks: formatCount,
  totalPutaways: formatCount,
  missionsInProgress: formatCount,
  missionsFailed: formatCount,
  completedPicklists: formatCount,
  averageWorktime: formatDuration,
  throughputPerHour: formatThroughput,
};

function renderKpis(snapshot) {
  for (const el of document.querySelectorAll('[data-kpi]')) {
    const key = el.dataset.kpi;
    const fmt = kpiFormatters[key] ?? formatCount;
    el.textContent = fmt(snapshot[key]);
  }
}

// --- snapshot fan-in ----------------------------------------------------------------------------
function applySnapshot(snapshot) {
  latestSnapshot = snapshot;
  const codes = (snapshot.ports ?? []).map((p) => p.portCode).filter(Boolean);
  if (codes.length) {
    knownPorts = codes;
    refreshPortOptions();
  }
  renderKpis(snapshot);
  renderGrid(snapshot);
  renderShiftTiles();
}

// --- snapshot polling + tick loop ---------------------------------------------------------------
// Replaces the ws/stats WebSocket (poll GetSnapshotJson ~4x/s) and the server-side tick service
// (call Tick ~5x/s). Both run against the in-browser C# runtime.
const connEl = document.getElementById('conn');

function setConn(state, text) {
  connEl.className = `conn ${state}`;
  connEl.textContent = text;
}

function connect() {
  setConn('online', 'live');
  setInterval(async () => {
    const snap = parse(await invoke('GetSnapshotJson'));
    if (snap) {
      applySnapshot(snap);
    }
  }, 250);
  setInterval(() => {
    invoke('Tick');
  }, 200);
}

// --- controls -----------------------------------------------------------------------------------
const simState = document.getElementById('sim-state');
const worktimeInput = document.getElementById('default-worktime'); // global default worktime (in the Shift view)
const randomnessInput = document.getElementById('worktime-randomness'); // ±% worktime randomness (Shift view)

function applyStatus(status) {
  if (!status) {
    return;
  }
  simState.textContent = status.isRunning ? 'running' : 'stopped';
  simState.className = `pill ${status.isRunning ? 'ok' : ''}`.trim();
  const auto = document.getElementById('chk-auto');
  if (auto) auto.checked = !!status.autoGenerate;
  setSimAnchor(status);
  renderSimClock();
  renderShiftTiles();
}

function worktimeLabel(value) {
  return `${Number(value).toFixed(1)}s`;
}

function wireControls() {
  document.getElementById('btn-start').addEventListener('click', async () => {
    applyStatus(await control('start'));
  });
  document.getElementById('btn-stop').addEventListener('click', async () => {
    applyStatus(await control('stop'));
  });
  document.getElementById('btn-seed').addEventListener('click', async () => {
    applyStatus(await control('seed'));
  });
  document.getElementById('chk-auto').addEventListener('change', async (e) => {
    applyStatus(await control('autogenerate', { enabled: e.target.checked }));
  });

  worktimeInput.addEventListener('change', async () => {
    applyStatus(await control('worktime', { meanSeconds: Number(worktimeInput.value), jitterSeconds: 0 }));
  });
  randomnessInput?.addEventListener('change', async () => {
    const percent = Math.max(0, Math.min(100, Number(randomnessInput.value) || 0));
    randomnessInput.value = String(percent);
    applyStatus(await control('randomness', { percent }));
  });
  document.getElementById('btn-clear').addEventListener('click', async () => {
    applyStatus(await control('reset')); // reset KPIs (server pushes zeroed snapshot)
  });
}

// --- small DOM helpers --------------------------------------------------------------------------
function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) {
    td.className = cls;
  }
  td.textContent = text;
  return td;
}

function pillCell(pill, dataset) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = `pill ${pill.cls}`.trim();
  span.textContent = pill.text;
  if (dataset) {
    for (const [k, v] of Object.entries(dataset)) {
      span.setAttribute(k, v);
    }
  }
  td.append(span);
  return td;
}

function emptyRow(span, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = span;
  td.className = 'empty';
  td.textContent = text;
  tr.append(td);
  return tr;
}

function formatWhen(iso) {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

// --- view switching (rail nav) ------------------------------------------------------------------
function setView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== name));
  document.querySelectorAll('.rail-icon[data-view]').forEach((a) => a.classList.toggle('is-active', a.dataset.view === name));
  if (name === 'dashboard') {
    renderShiftTiles();
    if (latestSnapshot) renderGrid(latestSnapshot);
  }
  if (name === 'shift') renderShifts();
  if (name === 'config') loadConfig();
  if (name === 'trace') {
    refreshTrace();
    if (!tracePoll) tracePoll = setInterval(refreshTrace, 3000);
  } else if (tracePoll) {
    clearInterval(tracePoll);
    tracePoll = null;
  }
  if (name === 'orders') {
    refreshOrders();
    if (!ordersPoll) ordersPoll = setInterval(refreshOrders, 2000);
  } else if (ordersPoll) {
    clearInterval(ordersPoll);
    ordersPoll = null;
  }
}
function wireNav() {
  document.querySelectorAll('.rail-icon[data-view]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); });
  });
  const initial = (location.hash || '').replace('#', '');
  if (document.querySelector(`.view[data-view="${initial}"]`)) setView(initial);
}

// --- staffing (client-side eval; the same plan drives the server tick via /api/sim/staffing) -----
// plan shape: { shifts: [{ name, start:"HH:mm", end:"HH:mm", assignments:[{ person, port, breaks:[{start,end}] }] }] }
let staffingPlan = { shifts: [] };

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(s ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// --- virtual simulation clock -------------------------------------------------------------------
// Anchored from the server's status: simMs is the virtual time the server reported at atMs (a local
// timestamp), so we tick forward using the LOCAL elapsed delta — immune to server/browser clock skew.
let simAnchor = null; // { simMs, atMs, running }

function setSimAnchor(status) {
  if (!status || !status.simulatedTimeUtc) { simAnchor = null; return; }
  simAnchor = {
    simMs: Date.parse(status.simulatedTimeUtc),
    atMs: Date.now(),
    running: !!status.clockRunning,
  };
}
function virtualNowMs() {
  if (!simAnchor) return Date.now();
  return simAnchor.running ? simAnchor.simMs + (Date.now() - simAnchor.atMs) : simAnchor.simMs;
}
function nowHM() {
  // The virtual epoch is expressed as a UTC time-of-day, matching the server's shift evaluation.
  const d = new Date(virtualNowMs());
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function pad2(n) { return String(n).padStart(2, '0'); }
function renderSimClock() {
  const el = document.getElementById('sim-clock');
  if (!el) return;
  if (!simAnchor) { el.textContent = '--:--:--'; return; }
  const d = new Date(virtualNowMs());
  el.textContent = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
function inWindow(startHM, endHM, hm) {
  if (startHM == null || endHM == null) return false;
  return startHM <= endHM ? (hm >= startHM && hm < endHM) : (hm >= startHM || hm < endHM);
}
function currentAssignment(portCode) {
  const hm = nowHM();
  for (const s of staffingPlan.shifts ?? []) {
    if (!inWindow(parseHM(s.start), parseHM(s.end), hm)) continue;
    for (const a of s.assignments ?? []) {
      if (a.port !== portCode) continue;
      const onBreak = (a.breaks ?? []).some((b) => inWindow(parseHM(b.start), parseHM(b.end), hm));
      return { person: a.person, onBreak };
    }
  }
  return null;
}
function currentOperator(portCode) {
  const a = currentAssignment(portCode);
  if (!a) return '—';
  return a.onBreak ? `${a.person} (break)` : a.person;
}

// --- dashboard shift tiles ----------------------------------------------------------------------
function renderShiftTiles() {
  const shifts = staffingPlan.shifts ?? [];
  const hm = nowHM();
  const active = [];
  let working = 0;
  let onBreak = 0;
  const breakNames = [];
  for (const s of shifts) {
    if (!inWindow(parseHM(s.start), parseHM(s.end), hm)) continue;
    active.push(s.name || 'Shift');
    for (const a of s.assignments ?? []) {
      const paused = (a.breaks ?? []).some((b) => inWindow(parseHM(b.start), parseHM(b.end), hm));
      if (paused) { onBreak++; breakNames.push(`${a.person} (${a.port})`); } else { working++; }
    }
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('shift-count', String(shifts.length));
  set('shift-active', active.length ? active.join(', ') : (shifts.length ? 'none now' : 'free-running'));
  set('shift-working', String(working));
  set('shift-break', String(onBreak));
  set('shift-detail', onBreak ? `On break: ${breakNames.join(', ')}` : '');
}

// --- AutoStore top-down grid --------------------------------------------------------------------
function renderGrid(snapshot) {
  const grid = document.getElementById('autostore-grid');
  if (!grid) return;
  const ports = snapshot.ports ?? [];
  const cols = Math.max(ports.length, 4);
  grid.style.setProperty('--cols', cols);
  const cells = [];
  for (let i = 0; i < cols * 2; i++) cells.push(h('div', { class: 'gcell bin-cell' })); // AutoStore bin field (top surface)
  for (const p of ports) {
    // "bin in port" for the full operator worktime = a mission admitted but not yet done (missionsAtPort);
    // fall back to missionsInProgress for older snapshots.
    const busy = (p.missionsAtPort ?? p.missionsInProgress ?? 0) > 0;
    const state = !p.isOpen ? 'closed' : (busy ? 'bin' : 'open');
    cells.push(h('div', { class: `gcell port-cell ${state}`, title: `${p.portCode} — ${state === 'closed' ? 'closed' : state === 'bin' ? 'bin in port' : 'open'}` },
      document.createTextNode(p.portCode)));
  }
  for (let i = ports.length; i < cols; i++) cells.push(h('div', { class: 'gcell empty-cell' }));
  grid.replaceChildren(...cells);
}

let knownPorts = [];
let latestSnapshot = null;

// small XSS-safe DOM builder
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'onclick') e.addEventListener('click', v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) e.append(kid);
  return e;
}

async function apiGetJson(path) {
  const q = path.indexOf('?');
  const name = q === -1 ? path : path.slice(0, q);
  const query = q === -1 ? '' : path.slice(q + 1);
  return parse(await invoke('GetJson', name, query));
}

// --- shift plan editor --------------------------------------------------------------------------
async function loadStaffingFromServer() {
  const plan = await apiGetJson('staffing');
  if (plan && Array.isArray(plan.shifts)) staffingPlan = plan;
}

function breaksView(assignment) {
  const wrap = h('span', { class: 'breaks' });
  (assignment.breaks ?? []).forEach((b, k) => {
    wrap.append(h('span', { class: 'pill warn break-pill' },
      document.createTextNode(`${b.start}–${b.end}`),
      h('button', { class: 'link-x', title: 'remove break', onclick: () => { assignment.breaks.splice(k, 1); renderShifts(); } }, document.createTextNode('×'))));
  });
  const bs = h('input', { type: 'time', value: '12:00', class: 'brk' });
  const be = h('input', { type: 'time', value: '12:30', class: 'brk' });
  wrap.append(bs, be, h('button', { class: 'ghost', onclick: () => {
    (assignment.breaks ??= []).push({ start: bs.value, end: be.value });
    renderShifts();
  } }, document.createTextNode('+ break')));
  return wrap;
}

function renderShifts() {
  const list = document.getElementById('shifts-list');
  if (!list) return;
  list.replaceChildren();
  if (!(staffingPlan.shifts ?? []).length) {
    list.append(h('p', { class: 'sub', text: 'No shifts yet — add one above, then assign a person to a port.' }));
    return;
  }
  staffingPlan.shifts.forEach((shift, i) => {
    const panel = h('section', { class: 'panel shift-card' });
    panel.append(h('div', { class: 'shift-head' },
      h('strong', { text: `${shift.name || 'Shift'} · ${shift.start}–${shift.end}` }),
      h('button', { class: 'ghost', title: 'Remove shift', onclick: () => { staffingPlan.shifts.splice(i, 1); renderShifts(); } },
        h('i', { class: 'fa-solid fa-trash' }))));

    (shift.assignments ?? []).forEach((a, j) => {
      panel.append(h('div', { class: 'assign-row' },
        h('span', { class: 'pill ok', text: a.person }),
        h('span', { class: 'assign-arrow', text: `→ ${a.port}` }),
        h('span', { class: 'assign-wt', text: a.worktimeSeconds != null ? `${a.worktimeSeconds}s` : 'default wt' }),
        breaksView(a),
        h('button', { class: 'ghost', title: 'Remove assignment', onclick: () => { shift.assignments.splice(j, 1); renderShifts(); } },
          h('i', { class: 'fa-solid fa-xmark' }))));
    });

    const person = h('input', { type: 'text', placeholder: 'Person name' });
    const used = new Set((shift.assignments ?? []).map((a) => a.port));
    const portSel = h('select', {}, h('option', { value: '', text: 'Port…' }),
      ...knownPorts.filter((p) => !used.has(p)).map((p) => h('option', { value: p, text: p })));
    const wt = h('input', { type: 'number', min: '0', step: '0.5', placeholder: 'Worktime s', class: 'wt-input' });
    panel.append(h('div', { class: 'assign-add' }, person, portSel, wt,
      h('button', { onclick: () => {
        const name = person.value.trim();
        if (!name || !portSel.value) return;
        const assignment = { person: name, port: portSel.value, breaks: [] };
        if (wt.value !== '') assignment.worktimeSeconds = Number(wt.value);
        (shift.assignments ??= []).push(assignment);
        renderShifts();
      } }, h('i', { class: 'fa-solid fa-user-plus' }), document.createTextNode(' Assign'))));

    list.append(panel);
  });
}

function wireShiftEditor() {
  document.getElementById('btn-add-shift')?.addEventListener('click', () => {
    const name = document.getElementById('shift-name').value.trim();
    const start = document.getElementById('shift-start').value || '08:00';
    const end = document.getElementById('shift-end').value || '16:00';
    (staffingPlan.shifts ??= []).push({ name, start, end, assignments: [] });
    document.getElementById('shift-name').value = '';
    renderShifts();
  });
  document.getElementById('btn-apply-staffing')?.addEventListener('click', async () => {
    const msg = document.getElementById('staffing-msg');
    const ok = await control('staffing', staffingPlan);
    if (msg) { msg.textContent = ok ? 'plan applied' : 'apply failed'; msg.className = `pill ${ok ? 'ok' : 'bad'}`; }
  });
  document.getElementById('btn-clear-staffing')?.addEventListener('click', async () => {
    staffingPlan = { shifts: [] };
    renderShifts();
    const msg = document.getElementById('staffing-msg');
    const ok = await control('staffing', staffingPlan); // empty plan -> ports run freely again
    if (msg) { msg.textContent = ok ? 'plan cleared' : 'clear failed'; msg.className = `pill ${ok ? 'ok' : 'bad'}`; }
  });
}

// --- trace --------------------------------------------------------------------------------------
let tracePoll = null;

function refreshPortOptions() {
  const sel = document.getElementById('trace-port');
  if (!sel) return;
  const cur = sel.value;
  sel.replaceChildren(h('option', { value: '', text: 'All ports' }), ...knownPorts.map((p) => h('option', { value: p, text: p })));
  sel.value = cur;
}

async function refreshTrace() {
  const body = document.getElementById('trace-body');
  if (!body) return;
  const q = new URLSearchParams();
  const port = document.getElementById('trace-port')?.value || '';
  const dir = document.getElementById('trace-dir')?.value || '';
  if (port) q.set('port', port);
  if (dir) q.set('dir', dir);
  q.set('sinceMinutes', '240');
  const rows = await apiGetJson(`trace?${q.toString()}`);
  const count = document.getElementById('trace-count');
  if (!rows || rows.length === 0) {
    body.replaceChildren(emptyRow(4, 'No transactions yet.'));
    if (count) count.textContent = '0';
    return;
  }
  if (count) count.textContent = String(rows.length);
  const dirClass = { RECV: 'trace-recv', SND: 'trace-snd', WORK: 'trace-work' };
  const dirLabel = { RECV: 'RECV →', SND: 'SND ←', WORK: 'WORK ⚙' };
  body.replaceChildren(...rows.map((r) => {
    const tr = document.createElement('tr');
    tr.className = dirClass[r.direction] ?? 'trace-snd';
    tr.append(
      cell(formatWhen(r.timestamp)),
      cell(dirLabel[r.direction] ?? r.direction, 'trace-dir-cell'),
      cell(r.portCode ?? '—'),
      cell(r.transaction),
    );
    return tr;
  }));
}

function wireTrace() {
  document.getElementById('trace-port')?.addEventListener('change', refreshTrace);
  document.getElementById('trace-dir')?.addEventListener('change', refreshTrace);
  document.getElementById('btn-trace-clear')?.addEventListener('click', async () => {
    await control('trace/clear'); // clear the server-side ring buffer + log
    refreshTrace();
  });
}

// --- eManager config (Config view) --------------------------------------------------------------
async function loadConfig() {
  const cfg = await apiGetJson('config');
  if (!cfg) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el != null) el.value = v; };
  set('cfg-mode', cfg.mode ?? 'Mock');
  set('cfg-baseuri', cfg.baseUri ?? '');
  set('cfg-username', cfg.username ?? '');
  const conn = document.getElementById('cfg-conn');
  if (conn) {
    conn.textContent = cfg.mode === 'Real'
      ? (cfg.connected ? `Connected to ${cfg.baseUri}` : `Not reachable: ${cfg.baseUri}`)
      : 'Using the built-in mock eManager.';
  }
  // Mock-free (release) build: hide the Mock option and the API/continuous panel.
  const mockOpt = document.getElementById('cfg-mode-mock');
  if (mockOpt) mockOpt.hidden = !cfg.allowMock;
  const apiPanel = document.getElementById('cfg-api-panel');
  if (apiPanel) apiPanel.hidden = !cfg.allowMock;
  const body = document.getElementById('config-exports-body');
  if (body) {
    const cfgs = cfg.exportConfigs ?? [];
    body.replaceChildren(...(cfgs.length
      ? cfgs.map((c) => {
          const tr = document.createElement('tr');
          tr.append(cell(c.name), cell(c.transactionType), pillCell(c.enabled ? { cls: 'ok', text: 'enabled' } : { cls: '', text: 'disabled' }));
          return tr;
        })
      : [emptyRow(3, 'No export configurations.')]));
  }
}

function wireConfig() {
  document.getElementById('btn-apply-config')?.addEventListener('click', async () => {
    const msg = document.getElementById('cfg-msg');
    const body = {
      mode: document.getElementById('cfg-mode')?.value ?? 'Mock',
      baseUri: document.getElementById('cfg-baseuri')?.value?.trim() || null,
      username: document.getElementById('cfg-username')?.value?.trim() || null,
      password: document.getElementById('cfg-password')?.value || null, // empty = keep current
    };
    const ok = await control('config', body);
    if (msg) { msg.textContent = ok ? 'config applied' : 'apply failed (check URL)'; msg.className = `pill ${ok ? 'ok' : 'bad'}`; }
    const pw = document.getElementById('cfg-password'); if (pw) pw.value = '';
    loadConfig();
  });
  document.getElementById('btn-sync')?.addEventListener('click', () =>
    runExportAction('exports/retransmit', 'Syncing…', (r) => `synced (${r.retransmitted} exports)`));
  document.getElementById('btn-uninstall')?.addEventListener('click', () =>
    runExportAction('exports/uninstall', 'Uninstalling…', (r) => `uninstalled (${r.remaining} left)`));
}

// Run a Sync/Uninstall export action, flipping the export status pill to a loading state meanwhile.
async function runExportAction(path, loadingText, okText) {
  const status = document.getElementById('cfg-export-status');
  const sync = document.getElementById('btn-sync');
  const uninstall = document.getElementById('btn-uninstall');
  if (sync) sync.disabled = true;
  if (uninstall) uninstall.disabled = true;
  if (status) {
    status.className = 'pill loading';
    status.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>${loadingText}`;
  }
  try {
    const res = await control(path);
    if (status) {
      status.className = `pill ${res ? 'ok' : 'bad'}`;
      status.textContent = res ? okText(res) : 'failed';
    }
    await loadConfig();
  } finally {
    if (sync) sync.disabled = false;
    if (uninstall) uninstall.disabled = false;
  }
}

// --- actual orders (Orders view) ----------------------------------------------------------------
let ordersPoll = null;

async function refreshOrders() {
  const body = document.getElementById('orders-body');
  if (!body) return;
  const orders = await apiGetJson('orders');
  if (!orders || orders.length === 0) {
    body.replaceChildren(emptyRow(6, 'No current orders.'));
    return;
  }
  body.replaceChildren(...orders.map((o) => {
    const tr = document.createElement('tr');
    const pill = o.status === 'Completed' ? { cls: 'ok', text: 'Completed' } : { cls: 'warn', text: o.status };
    tr.append(
      cell(o.portCode),
      cell(o.kind),
      cell(formatQuantity(o.quantity), 'num'),
      cell(o.location ?? '—'),
      cell(o.picklistId || '—'),
      pillCell(pill),
    );
    return tr;
  }));
}

// --- boot ---------------------------------------------------------------------------------------
async function init() {
  wireControls();
  wireNav();
  wireShiftEditor();
  wireTrace();
  wireConfig();
  await loadStaffingFromServer();
  setConn('connecting', 'connecting…');
  const status = await getStatus();
  if (status) {
    applyStatus(status);
    worktimeInput.value = String(status.worktimeMeanSeconds);
    if (randomnessInput) randomnessInput.value = String(status.worktimeRandomnessPercent ?? 0);
  }
  connect();

  // Tick the virtual clock every second so the dashboard time (and break-sensitive shift tiles)
  // stay live even between WebSocket snapshots.
  setInterval(() => {
    renderSimClock();
    renderShiftTiles();
  }, 1000);
}

init();
