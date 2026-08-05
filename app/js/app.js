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
  staffingCoverage,
  virtualNow,
} from './format.js';

// --- in-browser bridge --------------------------------------------------------------------------
// This build runs the ENTIRE simulation in the browser via Blazor WebAssembly. Instead of REST + a
// ws/stats WebSocket, the data layer calls the C# SimBridge ([JSInvokable]) directly and polls a
// snapshot. Only these three functions (control/getStatus/apiGetJson) — plus connect() below —
// changed; every render function is untouched.
const ASM = 'EManagerSimulationHandler.Wasm';
const invokeRaw = (method, ...args) => globalThis.DotNet.invokeMethodAsync(ASM, method, ...args);

// Every bridge call is failure-tolerant: a rejected interop call must never take down the poll/tick
// loops or the boot sequence. Repeated failures flip the connection pill so a dead runtime is visible
// instead of the UI silently claiming "live" forever.
let bridgeFailures = 0;
const FAILURES_BEFORE_OFFLINE = 5;

async function invoke(method, ...args) {
  try {
    const result = await invokeRaw(method, ...args);
    if (bridgeFailures > 0) {
      bridgeFailures = 0;
      setConn('online', 'live');
    }
    return result;
  } catch (err) {
    if (++bridgeFailures === FAILURES_BEFORE_OFFLINE) {
      setConn('offline', 'simulation error');
    }
    console.error(`bridge ${method} failed`, err);
    return null;
  }
}

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
    const changed = codes.join('|') !== knownPorts.join('|');
    knownPorts = codes;
    refreshPortOptions();
    if (changed) renderPortSummary(); // the discovered-port set moved -> refresh the shift view line
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

  // Both loops guard against re-entrancy: a slow/awaiting bridge call must not have a second one
  // interleave with it (the Core engine is not re-entrant), and neither loop may ever stall.
  let polling = false;
  setInterval(async () => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const snap = parse(await invoke('GetSnapshotJson'));
      if (snap) {
        applySnapshot(snap);
      }
    } finally {
      polling = false;
    }
  }, 250);

  let ticking = false;
  setInterval(async () => {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      await invoke('Tick');
    } finally {
      ticking = false;
    }
  }, 200);
}

// --- controls -----------------------------------------------------------------------------------
const simState = document.getElementById('sim-state');
const speedInput = document.getElementById('sim-speed'); // simulation speed factor x1-x20 (dashboard bar)
const speedValue = document.getElementById('sim-speed-value');
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
  applySpeedToControl(status);
  setSimAnchor(status);
  renderSimClock();
  renderShiftTiles();
}

// Hydrate the speed slider + its readout from the server's factor, without ever fighting a drag in
// progress: while the user holds the slider its own value wins and only the readout follows it.
function applySpeedToControl(status) {
  const factor = Number(status.speedFactor) || 1;
  const dragging = speedInput != null && document.activeElement === speedInput;
  if (speedInput && !dragging) speedInput.value = String(factor);
  if (speedValue) speedValue.textContent = `x${dragging ? speedInput.value : factor}`;
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
  // A range input needs BOTH events: `input` fires on every pixel of the drag (readout only, no
  // network), `change` fires once on release / keyboard commit and is the one that posts the factor.
  speedInput?.addEventListener('input', () => {
    if (speedValue) speedValue.textContent = `x${speedInput.value}`;
  });
  speedInput?.addEventListener('change', async () => {
    applyStatus(await control('speed', { factor: Number(speedInput.value) }));
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
  if (name === 'shift') { renderPortSummary(); renderShifts(); }
  if (name === 'config') loadConfig();
  if (name === 'history') refreshHistory();
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
  if (name === 'host') {
    refreshHost();
    if (!hostPoll) hostPoll = setInterval(refreshHost, 2000);
  } else if (hostPoll) {
    clearInterval(hostPoll);
    hostPoll = null;
  }
}
function wireNav() {
  document.querySelectorAll('.rail-icon[data-view]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); });
  });
  document.querySelectorAll('a.view-link[data-view]').forEach((a) => {
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
let simAnchor = null; // { simMs, atMs, running, speed }

function setSimAnchor(status) {
  if (!status || !status.simulatedTimeUtc) { simAnchor = null; return; }
  simAnchor = {
    simMs: Date.parse(status.simulatedTimeUtc),
    atMs: Date.now(),
    running: !!status.clockRunning,
    speed: Number(status.speedFactor) || 1,
  };
}
function virtualNowMs() {
  return virtualNow(simAnchor, Date.now());
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

// The discovered ports, in a stable (code) order — the same order the server fills them in.
function discoveredPorts() {
  return [...knownPorts].sort((a, b) => String(a).localeCompare(String(b)));
}

// "N ports discovered from the eManager: P01, P02, P03" — the port list is NOT hand-maintained, it is
// exactly what the eManager reported (GET api/AutoStorePortInfo), and it is known before Start.
function renderPortSummary() {
  const el = document.getElementById('shift-ports-summary');
  if (!el) return;
  const ports = discoveredPorts();
  el.textContent = ports.length
    ? `${ports.length} port${ports.length === 1 ? '' : 's'} discovered from the eManager: ${ports.join(', ')}`
    : 'No ports discovered from the eManager — check the Config page.';
}

function coverageView(shift) {
  const cover = staffingCoverage(discoveredPorts(), shift.assignments ?? []);
  const text = cover.unstaffed.length
    ? `Staffed ${cover.staffed} / ${cover.total} · unstaffed: ${cover.unstaffed.join(', ')}`
    : `Staffed ${cover.staffed} / ${cover.total}`;
  return h('div', { class: 'staff-coverage' },
    h('span', { class: `pill ${cover.unstaffed.length ? 'warn' : 'ok'}`, text }));
}

// Bulk staffing (spec 0012): one action staffs every discovered port of this shift from a template,
// instead of appending one assignment at a time. Both buttons edit the DRAFT plan only — the user
// still presses "Apply plan", exactly as for every other edit in this editor.
function bulkView(shift, i) {
  const pattern = h('input', { type: 'text', class: 'person-pattern', value: 'Operator {port}', placeholder: 'Person pattern' });
  const bulkWt = h('input', { type: 'number', min: '0', step: '0.5', placeholder: 'Worktime s', class: 'wt-input bulk-wt' });
  const staffAll = h('button', { class: 'staff-all', title: 'Assign every port the eManager reported', onclick: async () => {
    const body = { plan: staffingPlan, shiftIndex: i, personPattern: pattern.value };
    if (bulkWt.value !== '') body.worktimeSeconds = Number(bulkWt.value);
    const filled = await control('staffing/autofill', body);
    if (filled && Array.isArray(filled.shifts)) {
      staffingPlan = filled;
      renderShifts();
    }
  } }, h('i', { class: 'fa-solid fa-users' }), document.createTextNode(' Staff all ports'));
  const unstaffAll = h('button', { class: 'ghost unstaff-all', title: 'Remove every assignment of this shift', onclick: () => {
    shift.assignments = [];
    renderShifts();
  } }, h('i', { class: 'fa-solid fa-user-slash' }), document.createTextNode(' Unstaff all'));
  return h('div', { class: 'staff-bulk' }, pattern, bulkWt, staffAll, unstaffAll);
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

    // Bulk staffing + coverage live in their own containers, NEVER inside .assign-add.
    panel.append(bulkView(shift, i));
    panel.append(coverageView(shift));

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

// --- version line (spec 0014 strand A) ----------------------------------------------------------
// Read through the bridge from assembly metadata; never a literal in this file (CLAUDE.md §4).
//
// MIRRORING NOTE (spec 0015, open question 1): the server host also wires a whole `putaway` view here —
// initPutaway/parsePutawayFile/renderPutawayPreview/sendPutawayBatch/renderPutawayBatch/wirePutaway and
// the ~1 Hz batch poll. All of it is INTENTIONALLY ABSENT from this in-browser build and must stay
// absent: that feature's entire value is writing stock into a REAL customer eManager over
// POST api/directputaway, and this Pages demo is mock-only with nothing downstream consuming the stored
// stock. Do not "fix" this divergence in a mirroring pass; wasm.e2e.mjs asserts the view is NOT here.
// The shared js/format.js IS mirrored byte-for-byte (spec 0012 §5), so putawaySummary/batchCounters
// exist in this build too — deliberately unused.
//
// MIRRORING NOTE (spec 0014, open question 10): the server host has a whole `update` view wired here —
// renderVersion + renderUpdate/refreshUpdate/wireUpdate + the restart watcher. Everything except this
// version line is INTENTIONALLY ABSENT from this in-browser build and must stay absent: a browser tab
// cannot download to disk, swap a directory or restart a process, and the Pages demo is always-latest
// by construction (wasm-pages.yml replaces the whole app/ folder on every main push). Do not "fix"
// this divergence in a mirroring pass; wasm.e2e.mjs asserts the update view is NOT here.
async function renderVersion() {
  const el = document.getElementById('app-version');
  if (!el) return;
  const v = await apiGetJson('version');
  if (!v) return;
  el.textContent = `v${v.version}`;
  el.title = `Version ${v.informationalVersion} · ${v.runtimeIdentifier} · ${v.variant} build`;
}

// --- history data source (per-host seam) --------------------------------------------------------
// The ONLY host-specific line of the History view. The Web host reads GET /api/history; the browser
// build answers the same JSON shape from SimBridge. Keeping the seam here, outside the shared block
// below, is what lets that block stay byte-identical across the two hosts (spec 0022 AC20).
async function historyJson() {
  return apiGetJson('history');
}

// --- history view (spec 0022) --- SHARED BLOCK BEGIN --------------------------------------------
// The product change log: which version brought what. Everything below is byte-identical in the Web
// host's app.js and the Wasm host's app.js, and the reviewer diffs the two blocks to prove it (AC20).
// The only thing that differs between the hosts is the per-host seam historyJson(), defined OUTSIDE
// this block: GET /api/history in the server build, SimBridge.GetJson('history') in the browser
// build. Nothing in here branches on the host — the hosts differ in data, never in code.
//
// All parsing, grouping, classification and duplicate detection happened in Core. This renders.
const HISTORY_TYPE_LABEL = { feat: 'new', fix: 'fix', perf: 'faster' };
const HISTORY_SOURCE_TEXT = {
  Local: 'This build’s own history',
  Merged: 'Published history',
  Unavailable: 'Could not be checked',
};

function historyEntryRow(entry) {
  const row = h('div', { class: 'hist-entry' });
  row.append(h('span', {
    class: `hist-type hist-type-${entry.type}`,
    text: HISTORY_TYPE_LABEL[entry.type] ?? entry.type,
  }));
  row.append(h('span', { class: 'hist-summary', text: entry.summary }));
  if (entry.specNumber != null) {
    row.append(h('span', { class: 'hist-spec', text: `spec ${String(entry.specNumber).padStart(4, '0')}` }));
  }
  return row;
}

// One version's entries. Internal changes (chore/ci/docs/refactor/test/build) start hidden behind a
// toggle whose label carries the REAL count, so it can never lie about what it is hiding.
function historyGroupSection(group) {
  const section = h('section', { class: 'hist-group' });

  const head = h('div', { class: 'hist-head' });
  head.append(h('h3', {
    class: 'hist-version',
    text: group.isUnreleased ? 'Not yet released' : `Version ${group.version ?? group.heading}`,
  }));
  if (group.date) head.append(h('span', { class: 'hist-date', text: group.date }));
  if (group.isRunningVersion) head.append(h('span', { class: 'pill ok hist-running', text: 'you are running this' }));
  if (group.isUnreleased) {
    head.append(h('span', { class: 'hist-date', text: 'changes pushed since the last version' }));
  }
  section.append(head);

  const entries = Array.isArray(group.entries) ? group.entries : [];
  const visible = entries.filter((entry) => entry.isUserVisible);
  const internal = entries.filter((entry) => !entry.isUserVisible);

  if (visible.length === 0 && internal.length === 0) {
    section.append(h('p', { class: 'sub hist-none', text: 'Nothing recorded for this version.' }));
    return section;
  }

  const visibleBox = h('div', { class: 'hist-entries' });
  for (const entry of visible) visibleBox.append(historyEntryRow(entry));
  section.append(visibleBox);

  if (internal.length > 0) {
    const internalBox = h('div', { class: 'hist-entries hist-internal' });
    internalBox.hidden = true;
    for (const entry of internal) internalBox.append(historyEntryRow(entry));

    // The count comes from the entries actually rendered, so the label and the rows cannot disagree.
    const label = (shown) => `${shown ? 'Hide' : 'Show'} ${internal.length} internal change${internal.length === 1 ? '' : 's'}`;
    const toggle = h('button', { class: 'ghost hist-toggle', type: 'button', text: label(false) });
    toggle.addEventListener('click', () => {
      internalBox.hidden = !internalBox.hidden;
      toggle.textContent = label(!internalBox.hidden);
    });

    section.append(toggle);
    section.append(internalBox);
  }

  return section;
}

function renderHistory(history) {
  const groupsEl = document.getElementById('hist-groups');
  if (!groupsEl) return;
  const sourceEl = document.getElementById('hist-source');
  const noteEl = document.getElementById('hist-note');
  const errorEl = document.getElementById('hist-error');
  const problemsEl = document.getElementById('hist-problems');
  const emptyEl = document.getElementById('hist-empty');

  groupsEl.replaceChildren();
  if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; }
  if (problemsEl) { problemsEl.textContent = ''; problemsEl.hidden = true; }
  if (emptyEl) emptyEl.hidden = true;

  // The request itself failed. Saying nothing here would read as "no changes", which is the one
  // thing this view must never imply when it does not actually know.
  if (!history) {
    if (sourceEl) sourceEl.textContent = 'Could not be checked';
    if (noteEl) noteEl.textContent = '';
    if (errorEl) {
      errorEl.textContent = 'The version history could not be loaded from this app.';
      errorEl.hidden = false;
    }
    return;
  }

  if (sourceEl) sourceEl.textContent = HISTORY_SOURCE_TEXT[history.state] ?? history.state ?? '';
  if (noteEl) noteEl.textContent = history.note ?? '';

  // Unavailable renders the LOCAL entries plus a visible error — never an empty list.
  if (errorEl && history.error) {
    errorEl.textContent = history.error;
    errorEl.hidden = false;
  }

  const problems = Array.isArray(history.problems) ? history.problems : [];
  if (problemsEl && problems.length > 0) {
    problemsEl.textContent = `${problems.length} line${problems.length === 1 ? '' : 's'} of the change log could not be read: `
      + problems.map((problem) => `line ${problem.lineNumber}`).join(', ');
    problemsEl.hidden = false;
  }

  const groups = Array.isArray(history.groups) ? history.groups : [];
  for (const group of groups) groupsEl.append(historyGroupSection(group));

  // Genuinely nothing recorded — a different thing from "we could not find out", and it says so
  // rather than leaving a blank panel.
  if (history.isEmpty && emptyEl) emptyEl.hidden = false;
}

async function refreshHistory() {
  renderHistory(await historyJson());
}
// --- history view (spec 0022) --- SHARED BLOCK END ----------------------------------------------
// The bridge's Control takes a string body, so the base64 CSV goes straight through — the same bytes
// the Web host receives, decoded by the same Core reader.
async function controlCsv(base64) {
  return parse(await invoke('Control', 'host/picklists', base64));
}

// --- host/WMS simulator (spec 0016) -------------------------------------------------------------
// The second role this program plays: the customer's WMS, feeding the eManager picklist waves read
// from a CSV. Everything below is byte-identical between the two hosts; only controlCsv's transport
// differs (REST body vs SimBridge argument), and both send the SAME base64 bytes so the reader's
// BOM / UTF-8 / CP1252 detection behaves the same in the browser demo as on the server.
let hostPoll = null;

function hostFieldValues() {
  const num = (id, fallback) => {
    const raw = document.getElementById(id)?.value;
    const n = Number(raw);
    return raw === '' || Number.isNaN(n) ? fallback : n;
  };
  return {
    enabled: !!document.getElementById('host-enabled')?.checked,
    waveSize: num('host-wave-size', 5),
    refillThreshold: num('host-refill', 3),
    completionTimeoutSeconds: num('host-timeout', 15) * 60,
    loop: !!document.getElementById('host-loop')?.checked,
  };
}

// Responses can overtake each other (two field changes in quick succession, or a poll racing a
// post), and the LAST response to arrive would otherwise win regardless of which request was newest.
// A monotonic token makes the newest REQUEST the one that renders.
let hostSeq = 0;

async function applyHostStatus(pending) {
  const seq = ++hostSeq;
  const status = await pending;
  if (seq === hostSeq) renderHost(status);
}

// Two field changes in quick succession are two independent requests, and the older one can reach the
// host LAST — leaving the clamped intermediate state ("refill at" clamped against the wave size the
// user has just replaced) as the final answer, so the run feeds a wave nobody asked for. Chaining
// alone does NOT fix that, and it is worth spelling out why: with only a chain, the first response
// arrives before the second request is sent, hydrates its own clamped value straight back into the
// input, and the second request then faithfully sends that clamped value on. Both halves are needed:
//   1. the posts are chained, so the wire order is the user's order; and
//   2. the payload is the intent captured SYNCHRONOUSLY at the change, and only the LAST queued post
//      is allowed to render — an intermediate response never touches the fields.
let hostConfigChain = Promise.resolve();
let hostConfigQueued = 0;
let hostConfigAnswered = 0;

/// While an edit is still on its way to the host, the host's status is BEHIND the user and must not
/// be written back into the wave fields.
function hostConfigSettled() {
  return hostConfigAnswered === hostConfigQueued;
}

function postHostConfig() {
  // Captured in a LOCAL const, read synchronously at the change: the payload this request sends can then
  // never be swapped for a later edit's values while it waits its turn in the chain.
  const wanted = hostFieldValues();
  const mine = ++hostConfigQueued;
  hostConfigChain = hostConfigChain
    .catch(() => {})
    .then(async () => {
      let status = null;
      try {
        status = await control('host/config', wanted);
      } finally {
        // Even a failed post must settle, or the fields would never hydrate again.
        hostConfigAnswered = mine;
      }
      if (mine === hostConfigQueued) {
        applyHostStatus(Promise.resolve(status));
      }
    });
  return hostConfigChain;
}

// Base64 keeps ONE client code path across REST and the in-browser bridge (spec 0016 §7).
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function loadHostCsv() {
  const file = document.getElementById('host-csv')?.files?.[0];
  const bytes = file
    ? new Uint8Array(await file.arrayBuffer())
    : new TextEncoder().encode(document.getElementById('host-csv-paste')?.value ?? '');

  const result = await controlCsv(toBase64(bytes));
  renderHostLoad(result);
  await refreshHost();
}

function renderHostLoad(result) {
  const msg = document.getElementById('host-load-msg');
  const list = document.getElementById('host-errors');
  if (!result) {
    if (msg) msg.textContent = 'Not loaded — the request failed.';
    if (list) list.replaceChildren();
    return;
  }
  const errors = result.errors ?? [];
  if (msg) {
    // Columns the eManager has no field for are NAMED, not silently dropped: the customer's file carries
    // task_type/bins/date_sim/day_sim, and a user has to be able to see they were read and ignored.
    const ignored = result.ignoredColumns ?? [];
    const ignoredNote = ignored.length ? ` — read but not sent: ${ignored.join(', ')}` : '';
    msg.textContent = result.accepted
      ? `Loaded ${result.picklistCount} picklists / ${result.lineCount} lines (delimiter "${result.delimiter}", ${result.encoding})${ignoredNote}`
      : `Not loaded — ${errors.length} problem${errors.length === 1 ? '' : 's'}:`;
  }
  if (list) {
    list.replaceChildren(...errors.map((e) => h('li', {
      text: e.lineNumber > 0 ? `line ${e.lineNumber}: ${e.reason}` : e.reason,
    })));
  }
}

function renderHost(status) {
  if (!status) return;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = String(value); };
  const state = document.getElementById('host-state');
  if (state) {
    state.textContent = status.state;
    state.className = `pill ${status.state === 'Feeding' ? 'ok' : status.state === 'Paused' ? 'bad' : ''}`.trim();
  }
  set('host-backlog', status.backlogRemaining);
  set('host-inflight', status.inFlight);
  set('host-completed', status.completed);
  set('host-timedout', status.timedOut);
  set('host-failed', status.submitFailed);

  const err = document.getElementById('host-error');
  if (err) {
    err.textContent = status.lastError ?? '';
    err.hidden = !status.lastError;
  }

  // Only hydrate the inputs the user is not currently typing into, so a poll never fights the caret —
  // and only once every edit has been answered. A poll landing between two edits would otherwise
  // revert the first field to the host's stale value, and the second edit would then snapshot that
  // reverted value and send it on as if the user had asked for it.
  if (hostConfigSettled()) {
    const hydrate = (id, value) => {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = String(value);
    };
    hydrate('host-wave-size', status.waveSize);
    hydrate('host-refill', status.refillThreshold);
    hydrate('host-timeout', Math.round(status.completionTimeoutSeconds / 60));
    const enabled = document.getElementById('host-enabled');
    if (enabled && document.activeElement !== enabled) enabled.checked = !!status.enabled;
    const loop = document.getElementById('host-loop');
    if (loop && document.activeElement !== loop) loop.checked = !!status.loop;
  }

  const body = document.getElementById('host-inflight-body');
  if (!body) return;
  const rows = status.inFlightPicklists ?? [];
  const warnAt = status.completionTimeoutSeconds * 0.8;
  body.replaceChildren(...(rows.length
    ? rows.map((p) => {
        const tr = document.createElement('tr');
        // A row past 80% of its budget warns BEFORE it is counted, so a stall is visible early.
        if (p.ageSeconds >= warnAt) tr.className = 'warn';
        tr.append(
          cell(p.picklistId),
          cell(String(p.lineCount), 'num'),
          cell(formatWhen(p.releasedAt)),
          cell(String(Math.round(p.ageSeconds)), 'num'),
        );
        return tr;
      })
    : [emptyRow(4, 'Nothing in flight.')]));
}

function refreshHost() {
  return applyHostStatus(apiGetJson('host/status'));
}

function wireHost() {
  document.getElementById('btn-host-load')?.addEventListener('click', loadHostCsv);
  document.getElementById('btn-host-reset')?.addEventListener('click', () => applyHostStatus(control('host/reset')));
  for (const id of ['host-enabled', 'host-wave-size', 'host-refill', 'host-timeout', 'host-loop']) {
    document.getElementById(id)?.addEventListener('change', postHostConfig);
  }
}

// --- boot ---------------------------------------------------------------------------------------
async function init() {
  wireControls();
  wireNav();
  wireShiftEditor();
  wireTrace();
  wireHost();
  wireConfig();

  // Start the poll/tick loops FIRST: a failure while restoring the initial state must never leave the
  // dashboard rendered-but-frozen because the intervals were never created.
  connect();
  await renderVersion();
  await loadStaffingFromServer();
  const status = await getStatus();
  if (status) {
    applyStatus(status);
    worktimeInput.value = String(status.worktimeMeanSeconds);
    if (randomnessInput) randomnessInput.value = String(status.worktimeRandomnessPercent ?? 0);
  }

  // Tick the virtual clock every second so the dashboard time (and break-sensitive shift tiles)
  // stay live even between snapshots.
  setInterval(() => {
    renderSimClock();
    renderShiftTiles();
  }, 1000);
}

init().catch((err) => {
  console.error('dashboard boot failed', err);
  setConn('offline', 'boot failed');
});
