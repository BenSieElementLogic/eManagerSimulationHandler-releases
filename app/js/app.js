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
  formatSimTime,
  portCellState,
  portCellLabel,
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
  // Start/Stop are mutually exclusive with the run state: you cannot start a running sim, nor stop a
  // stopped one, so grey out the button that would be a no-op.
  const running = !!status.isRunning;
  const startBtn = document.getElementById('btn-start');
  const stopBtn = document.getElementById('btn-stop');
  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
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
  setActiveRail(name);
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

// Mark the active page link and its owning category icon (spec 0038). Derived from the DOM — the
// panel link with this data-view names the section — so there is no second view→section table to
// drift out of step with the markup (the panel that lists the page IS the active section).
function setActiveRail(name) {
  document.querySelectorAll('.rail-subnav.is-active').forEach((a) => a.classList.remove('is-active'));
  document.querySelectorAll('.rail-icon.is-active').forEach((b) => b.classList.remove('is-active'));
  const link = document.querySelector(`.rail-subnav[data-view="${name}"]`);
  if (!link) return;
  link.classList.add('is-active');
  const section = link.closest('.rail-panel')?.dataset.section;
  if (section) document.querySelector(`.rail-icon[data-section="${section}"]`)?.classList.add('is-active');
}

function wireNav() {
  document.querySelectorAll('a.rail-subnav[data-view]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); });
  });
  document.querySelectorAll('a.view-link[data-view]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); setView(a.dataset.view); });
  });
  const initial = (location.hash || '').replace('#', '');
  if (document.querySelector(`.view[data-view="${initial}"]`)) setView(initial);
}

// --- rail category menu (spec 0038) -------------------------------------------------------------
// The interaction model, ported from elws web-muse use-rail-menu.ts + menu-aim.ts: a rail icon is a
// CATEGORY that opens an overlay panel of page links. CLICK arms + opens (a cold hover never opens);
// once armed, HOVER swaps panels, guarded by the "magic triangle" — a rail icon clipped while the
// pointer aims into the open panel is held, not honoured. Auto-close on leaving the region, a
// pointerdown outside, the × label, or clicking a page link.

// AUTO_CLOSE_MS — grace before an open panel closes after the pointer leaves the rail+panel region.
const AUTO_CLOSE_MS = 750;
// AIM_HOLD_MS — safety-valve dwell for the magic triangle: a held swap fires only if the pointer
// STOPS this long mid-flight over an intervening icon (a steady move re-arms it).
const AIM_HOLD_MS = 500;
// AIM_TOLERANCE — vertical slack (px) added above/below the panel edge so a cursor sweeping just
// past a corner still reads as aiming for the panel.
const AIM_TOLERANCE = 40;

// isAimingAtPanel — true when a pointer travelling prev→curr is pointed into `panel`, which opens to
// the RIGHT of the rail. Projects the movement ray forward to the panel's near (left) edge and asks
// whether it lands within the panel's vertical span (+ tolerance). Not moving rightward, or already
// at/past the edge, is by definition not aiming.
function isAimingAtPanel(prev, curr, panel) {
  const dx = curr.x - prev.x;
  if (dx <= 0) return false;
  if (curr.x >= panel.left) return false;
  const t = (panel.left - curr.x) / dx;
  const projectedY = curr.y + (curr.y - prev.y) * t;
  return projectedY >= panel.top - AIM_TOLERANCE && projectedY <= panel.bottom + AIM_TOLERANCE;
}

function wireRailMenu() {
  const root = document.querySelector('.rail-shell');
  if (!root) return;

  let open = null;         // active section id (null = none)
  let armed = false;       // a cold hover never opens; a click arms
  let closeTimer;
  let aimTimer;
  let hoverSection = null; // the section the pointer is over (the swap target)
  let lastPoint = null;
  let prevPoint = null;

  const radioFor = (id) => document.getElementById('rail-sec-' + (id ?? 'none'));
  const applyOpen = () => { const r = radioFor(open); if (r) r.checked = true; };
  const setOpen = (id) => { open = id; applyOpen(); };

  const openPanel = () => (open ? root.querySelector(`.rail-panel[data-section="${open}"]`) : null);

  const recordPoint = (x, y) => {
    // Drop a duplicate sample: mouseover+mousemove fire at the SAME point crossing onto an icon, and
    // recording both collapses the aim vector to dx=0 — committing the held swap.
    if (lastPoint && lastPoint.x === x && lastPoint.y === y) return;
    prevPoint = lastPoint;
    lastPoint = { x, y };
  };

  const aimingAtOpenPanel = () => {
    if (!prevPoint || !lastPoint) return false;
    const panel = openPanel();
    if (!panel) return false;
    const r = panel.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return isAimingAtPanel(prevPoint, lastPoint, { left: r.left, top: r.top, bottom: r.bottom });
  };

  const clearAim = () => { clearTimeout(aimTimer); aimTimer = undefined; };
  const resetAim = () => { clearAim(); hoverSection = null; lastPoint = null; prevPoint = null; };

  const commitSwitch = (sectionId) => {
    clearAim();
    if (!sectionId) return;
    setOpen(sectionId === 'none' ? null : sectionId);
  };

  const closeMenu = () => {
    armed = false;
    clearTimeout(closeTimer);
    resetAim();
    setOpen(null);
  };

  // Hover swaps only once armed. Aiming into the open panel HOLDS the swap behind AIM_HOLD_MS
  // (mousemove commits early); otherwise it switches at once.
  const switchOnHover = (sectionId, e) => {
    hoverSection = sectionId;
    if (e) recordPoint(e.clientX, e.clientY);
    if (!armed) return;
    if (aimingAtOpenPanel()) {
      clearTimeout(aimTimer);
      aimTimer = setTimeout(() => commitSwitch(hoverSection), AIM_HOLD_MS);
    } else {
      commitSwitch(sectionId);
    }
  };

  root.addEventListener('click', (e) => {
    const target = e.target;
    const icon = target.closest('.rail-icon[data-section]');
    if (icon) {
      armed = true;
      setOpen(icon.dataset.section);
      return;
    }
    if (target.closest('.rail-panel-close, a.rail-subnav')) closeMenu();
  });

  // Reaching the open panel cancels any held swap (mouseover fires as the pointer crosses in);
  // hovering a rail icon (armed) swaps to it, guarded by the magic triangle.
  root.addEventListener('mouseover', (e) => {
    if (e.target.closest('.rail-panel')) { clearAim(); hoverSection = null; return; }
    const icon = e.target.closest('.rail-icon[data-section]');
    if (icon && icon.dataset.section !== hoverSection) switchOnHover(icon.dataset.section, e);
  });

  // Drives the held swap off motion: commit it once the pointer reaches the panel column (keep the
  // panel) or stops aiming (honour the icon); a steady approach re-arms the dwell.
  root.addEventListener('mousemove', (e) => {
    recordPoint(e.clientX, e.clientY);
    if (aimTimer === undefined) return;
    const panel = openPanel();
    if (panel) {
      const r = panel.getBoundingClientRect();
      if (!(r.width === 0 && r.height === 0) && e.clientX >= r.left) { clearAim(); return; }
    }
    if (aimingAtOpenPanel()) {
      clearTimeout(aimTimer);
      aimTimer = setTimeout(() => commitSwitch(hoverSection), AIM_HOLD_MS);
    } else {
      commitSwitch(hoverSection);
    }
  });

  root.addEventListener('mouseenter', () => clearTimeout(closeTimer));
  root.addEventListener('mouseleave', () => {
    resetAim();
    if (!armed) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeMenu, AUTO_CLOSE_MS);
  });

  // A pointerdown outside the rail+panel region closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!root.contains(e.target)) closeMenu();
  });

  // Test hook (elws exports these for its tests too): the aim geometry + timing constants, so the
  // E2E can pin isAimingAtPanel's cases directly in the real engine.
  window.__rail = { isAimingAtPanel, AIM_TOLERANCE, AIM_HOLD_MS, AUTO_CLOSE_MS };
}


// --- staffing (client-side eval; the same plan drives the server tick via /api/sim/staffing) -----
// plan shape: { shifts: [{ name, start:"HH:mm", end:"HH:mm", assignments:[{ person, port, breaks:[{start,end}] }] }] }
let staffingPlan = { shifts: [] };

// spec 0046: which shift cards are collapsed. Client-only, per-browser view state — NEVER stored on
// `shift`/`staffingPlan` (that would leak UI state into the persisted/POSTed plan). Keyed by a
// composite of name|start|end so the collapsed state stays with the intended card across
// add/remove/staff-all splices of staffingPlan.shifts. Caveat: two shifts with an identical
// name+start+end collapse together — an accepted, low-impact collision, strictly better than a bare
// index key that mis-attaches state after a splice.
const collapsedShifts = new Set();
const shiftKey = (shift) => `${shift.name}|${shift.start}|${shift.end}`;

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
  // Share the one UTC formatter with the Trace "When" column so the KPI clock and the trace cannot diverge.
  el.textContent = formatSimTime(new Date(virtualNowMs()).toISOString());
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
  // Sort ports in ascending order by code. Uses a numeric-aware compare so purely numeric codes
  // ("2" before "10") and prefixed codes ("P02" before "P10") both order the way a human expects.
  const ports = [...(snapshot.ports ?? [])].sort((a, b) =>
    String(a.portCode).localeCompare(String(b.portCode), undefined, { numeric: true, sensitivity: 'base' }));
  const cols = Math.max(ports.length, 4);
  grid.style.setProperty('--cols', cols);
  const cells = [];
  for (let i = 0; i < cols * 2; i++) cells.push(h('div', { class: 'gcell bin-cell' })); // AutoStore bin field (top surface)
  for (const p of ports) {
    // Cell state precedence (spec 0038 Amd C) via the pure portCellState. The mock-only Wasm demo never
    // sets p.activity, so it renders closed/bin/open exactly as before; login/binwait are mirrored for
    // parity with the Web host.
    const state = portCellState(p);
    cells.push(h('div', { class: `gcell port-cell ${state}`, title: `${p.portCode} — ${portCellLabel(state)}` },
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
let availableTaskTypes = []; // Loaded from /api/sim/tasktypes

async function loadStaffingFromServer() {
  const plan = await apiGetJson('staffing');
  if (plan && Array.isArray(plan.shifts)) staffingPlan = plan;
}

async function loadTaskTypesFromServer() {
  const types = await apiGetJson('tasktypes');
  if (types && Array.isArray(types)) {
    availableTaskTypes = types.filter(t => !t.outdated).map(t => ({
      id: t.idTaskType,
      name: t.name || `Task Type ${t.idTaskType}`,
    }));
  }
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

// "N ports discovered from eManager." — the count is NOT hand-maintained, it is
// exactly what the eManager reported (GET api/AutoStorePortInfo), and it is known before Start.
function renderPortSummary() {
  const el = document.getElementById('shift-ports-summary');
  if (!el) return;
  const ports = discoveredPorts();
  el.textContent = ports.length
    ? `${ports.length} port${ports.length === 1 ? '' : 's'} discovered from eManager.`
    : 'No ports discovered from eManager — check the eManager Link page.';
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
  // Test-hook (spec 0046): expose the live draft plan so e2e can assert no collapse state leaks in.
  window.__staffingPlan = staffingPlan;
  list.replaceChildren();
  if (!(staffingPlan.shifts ?? []).length) {
    list.append(h('p', { class: 'sub', text: 'No shifts yet — add one above, then assign a person to a port.' }));
    return;
  }
  staffingPlan.shifts.forEach((shift, i) => {
    const panel = h('section', { class: 'panel shift-card' });
    // spec 0046: collapse state is client-only, keyed by name|start|end (see collapsedShifts).
    const collapsed = collapsedShifts.has(shiftKey(shift));
    const collapseBtn = h('button', {
      class: 'ghost',
      title: collapsed ? 'Expand shift' : 'Collapse shift',
      'aria-label': collapsed ? 'Expand shift' : 'Collapse shift',
      'aria-expanded': collapsed ? 'false' : 'true',
      onclick: () => {
        const key = shiftKey(shift);
        if (collapsedShifts.has(key)) collapsedShifts.delete(key); else collapsedShifts.add(key);
        renderShifts();
      },
    }, h('i', { class: `fa-solid ${collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}` }));
    panel.append(h('div', { class: 'shift-head' },
      h('strong', { text: `${shift.name || 'Shift'} · ${shift.start}–${shift.end}` }),
      h('button', { class: 'ghost', title: 'Remove shift', onclick: () => { staffingPlan.shifts.splice(i, 1); renderShifts(); } },
        h('i', { class: 'fa-solid fa-trash' })),
      collapseBtn));

    // spec 0046: everything below the head lives in one .shift-body so a single toggle collapses it all.
    const body = h('div', { class: 'shift-body' });
    if (collapsed) body.setAttribute('hidden', '');

    // Bulk staffing lives ABOVE the per-port assignment rows so it stays on-screen even when every port
    // is staffed and the list of individual assignments grows long. It has its own container, NEVER inside
    // .assign-add.
    body.append(bulkView(shift, i));

    const person = h('input', { type: 'text', placeholder: 'Person name', class: 'person-input' });
    const used = new Set((shift.assignments ?? []).map((a) => a.port));
    const portSel = h('select', {}, h('option', { value: '', text: 'Port…' }),
      ...knownPorts.filter((p) => !used.has(p)).map((p) => h('option', { value: p, text: p })));
    const wt = h('input', { type: 'number', min: '0', step: '0.5', placeholder: 'Worktime s', class: 'wt-input' });
    
    // Task type multi-select: reusable helper creates the dropdown with current selection
    const createTaskTypeMultiSelect = (initialIds = [], idPrefix = '') => {
      // Ensure all IDs are numbers for consistent comparison
      const selectedIds = initialIds.map(id => Number(id));
      const dropdown = h('div', { class: 'task-type-select' });
      
      const updateButtonText = () => {
        if (selectedIds.length === 0) {
          input.value = '';
        } else {
          const names = selectedIds.map(id => {
            const tt = availableTaskTypes.find(t => t.id === id);
            return tt ? tt.name : String(id);
          });
          input.value = names.join(', ');
        }
      };
      
      const input = h('input', { 
        type: 'text',
        class: 'task-type-input',
        placeholder: 'Task Types',
        readonly: true,
        onclick: (e) => {
          e.preventDefault();
          dropdown.classList.toggle('open');
        }
      });
      
      const menu = h('div', { class: 'task-type-menu' });
      
      if (availableTaskTypes.length > 0) {
        availableTaskTypes.forEach(tt => {
          const checkbox = h('input', { 
            type: 'checkbox', 
            id: `tt-${idPrefix}-${tt.id}`, 
            value: tt.id
          });
          // Set checked state as a property, not attribute
          checkbox.checked = selectedIds.includes(tt.id);
          
          const label = h('label', { 
            for: `tt-${idPrefix}-${tt.id}`, 
            text: tt.name
          });
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
              if (!selectedIds.includes(tt.id)) {
                selectedIds.push(tt.id);
              }
            } else {
              const idx = selectedIds.indexOf(tt.id);
              if (idx !== -1) selectedIds.splice(idx, 1);
            }
            updateButtonText();
          });
          menu.append(h('div', { class: 'task-type-option' }, checkbox, label));
        });
      } else {
        menu.append(h('div', { class: 'task-type-empty', text: 'No task types configured' }));
      }
      
      updateButtonText();
      dropdown.append(input, menu);
      return { dropdown, selectedIds };
    };
    
    const { dropdown: taskTypeDropdown, selectedIds: taskTypeIds } = createTaskTypeMultiSelect([], `${shift.name}-add`);
    
    // spec 0046: per-port form sits directly under bulk staffing and ABOVE the assignment rows.
    body.append(h('div', { class: 'assign-add' }, person, portSel, wt, taskTypeDropdown,
      h('button', { onclick: () => {
        const name = person.value.trim();
        if (!name || !portSel.value) return;
        const assignment = { person: name, port: portSel.value, breaks: [] };
        if (wt.value !== '') assignment.worktimeSeconds = Number(wt.value);
        if (taskTypeIds.length > 0) assignment.taskTypeIds = [...taskTypeIds];
        (shift.assignments ??= []).push(assignment);
        renderShifts();
      } }, h('i', { class: 'fa-solid fa-user-plus' }), document.createTextNode(' Assign'))));

    // Coverage (Staffed n / n) sits directly above the individual assignment rows.
    body.append(coverageView(shift));

    (shift.assignments ?? []).forEach((a, j) => {
      // Task type multi-select for existing assignment
      const { dropdown: rowTaskTypeDropdown, selectedIds: rowTaskTypeIds } = createTaskTypeMultiSelect(
        a.taskTypeIds || [], 
        `${shift.name}-${j}`
      );
      
      // Update assignment when selection changes (selectedIds is live-updated by the dropdown)
      const syncToAssignment = () => {
        if (rowTaskTypeIds.length > 0) {
          a.taskTypeIds = [...rowTaskTypeIds];
        } else {
          delete a.taskTypeIds;
        }
      };
      
      // Watch for changes by periodically syncing (the checkboxes update selectedIds directly)
      rowTaskTypeDropdown.addEventListener('click', (e) => {
        // Sync when menu closes (clicked outside or on button again)
        if (e.target.classList.contains('task-type-btn') && rowTaskTypeDropdown.classList.contains('open')) {
          syncToAssignment();
        }
      });
      
      body.append(h('div', { class: 'assign-row' },
        h('span', { class: 'pill ok', text: a.person }),
        h('span', { class: 'assign-arrow', text: `→ ${a.port}` }),
        h('span', { class: 'assign-wt', text: a.worktimeSeconds != null ? `${a.worktimeSeconds}s` : 'default wt' }),
        rowTaskTypeDropdown,
        breaksView(a),
        h('button', { class: 'ghost', title: 'Remove assignment', onclick: () => { shift.assignments.splice(j, 1); renderShifts(); } },
          h('i', { class: 'fa-solid fa-xmark' }))));
    });

    panel.append(body);
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
      cell(formatSimTime(r.timestamp)),
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

// --- eManager config (eManager Link view) --------------------------------------------------------
// The rail logo is mode-branded (spec: blue in Mock, Element red in Real). Reflect the active eManager
// mode onto <html data-mode> so the CSS in dashboard.css can colour the logo; absent = mock/blue.
function applyMode(mode) {
  const real = String(mode ?? '').toLowerCase() === 'real';
  document.documentElement.dataset.mode = real ? 'real' : 'mock';
}

async function loadConfig() {
  const cfg = await apiGetJson('config');
  if (!cfg) return;
  applyMode(cfg.mode);
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
// ----- host transport trio (Wasm) ---------------------------------------------------------------
// The browser build has no server and no temp file, so the CSV bytes are re-passed on every call: the
// upload keeps the base64 in a module var and remap/load hand it straight back to the same Core reader.
// Only these three functions differ from the Web host; every render/read helper below is byte-identical.
let hostStoredCsv = null;

async function hostUpload(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  hostStoredCsv = toBase64(bytes);
  const view = parse(await invoke('Control', 'host/picklists/upload', JSON.stringify({ csv: hostStoredCsv, mapping: null })));
  return view ? { uploadId: 'wasm', view } : null;
}

async function hostRemap(uploadId, mapping) {
  if (hostStoredCsv == null) return null;
  const view = parse(await invoke('Control', 'host/picklists/remap', JSON.stringify({ csv: hostStoredCsv, mapping })));
  return view ? { uploadId, view } : null;
}

async function hostLoad(uploadId, mapping) {
  if (hostStoredCsv == null) return null;
  const view = parse(await invoke('Control', 'host/picklists/load', JSON.stringify({ csv: hostStoredCsv, mapping })));
  return view ? { uploadId, view } : null;
}

// --- host/WMS simulator (spec 0016) -------------------------------------------------------------
// The second role this program plays: the customer's WMS, feeding the eManager picklist waves read
// from a CSV. Everything below is byte-identical between the two hosts; only the upload/remap/load
// transport trio differs (REST vs SimBridge), and both drive the SAME Core reader so the mapping
// preview and BOM / UTF-8 / CP1252 detection behave the same in the browser demo as on the server.
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

// ----- host import: shared upload → mapping preview → confirm flow (mirrors Direct Putaway) -------
// Everything from here down is byte-identical between the two hosts; only the transport trio above
// differs. The stored uploadId keys the host-side (or, on Wasm, browser-side) copy of the file, so a
// re-map or a load never re-sends the bytes. The ignore target is the literal string "Ignore".
let hostUploadId = null;

// A File built from the chosen file, or from the paste textarea when no file is selected — one code
// path feeds the same transport trio either way.
function hostSelectedFile() {
  const file = document.getElementById('host-csv')?.files?.[0];
  if (file) return file;
  const text = document.getElementById('host-csv-paste')?.value ?? '';
  if (!text) return null;
  return new File([new TextEncoder().encode(text)], 'pasted.csv', { type: 'text/csv' });
}

// A status badge beside the Upload button (mirrors Direct Putaway's dpaSetMessage): the user sees
// "uploading…" the instant they click — not a frozen screen until the whole file has streamed — then
// "uploaded" / "not accepted" / a failure.
function hostSetStatus(text, cls) {
  const el = document.getElementById('host-upload-msg');
  if (!el) return;
  el.className = `pill ${cls ?? ''}`.trim();
  if (cls === 'loading') {
    el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>${text}`;
  } else {
    el.textContent = text;
  }
}

async function previewHostUpload() {
  const file = hostSelectedFile();
  if (!file) { hostSetStatus('choose a CSV file first', 'bad'); renderHostPreview(null); return; }
  hostSetStatus('uploading…', 'loading');
  const result = await hostUpload(file);
  if (!result) { hostSetStatus('upload failed', 'bad'); renderHostPreview(null); return; }
  hostUploadId = result.uploadId;
  hostSetStatus(result.view.accepted ? 'uploaded' : 'not accepted', result.view.accepted ? 'ok' : 'bad');
  renderHostPreview(result.view);
}

async function remapHostUpload() {
  if (!hostUploadId) return;
  // Re-parses the whole CSV (slow on large uploads), so disable the run buttons and show the reused spinner
  // while it is in flight — mirrors runExportAction. renderHostPreview has the final word on
  // btn-host-load / btn-host-import via view.accepted, so finally only blanket re-enables the others.
  // (The Wasm host has no btn-host-import; the ?-style guards below tolerate its absence.)
  const remap = document.getElementById('btn-host-remap');
  const load = document.getElementById('btn-host-load');
  const importAll = document.getElementById('btn-host-import');
  const upload = document.getElementById('btn-host-upload');
  const reset = document.getElementById('btn-host-reset');
  if (remap) remap.disabled = true;
  if (load) load.disabled = true;
  if (importAll) importAll.disabled = true;
  if (upload) upload.disabled = true;
  if (reset) reset.disabled = true;
  hostSetStatus('applying…', 'loading');
  try {
    const result = await hostRemap(hostUploadId, readHostMapping());
    if (!result) {
      hostSetStatus('re-apply failed', 'bad');
      // No preview to re-gate load/import, so re-enable them here (do not force them enabled on success).
      if (load) load.disabled = false;
      if (importAll) importAll.disabled = false;
      return;
    }
    hostSetStatus(result.view.accepted ? 'remapped' : 'not accepted', result.view.accepted ? 'ok' : 'bad');
    renderHostPreview(result.view);
  } finally {
    if (remap) remap.disabled = false;
    if (upload) upload.disabled = false;
    if (reset) reset.disabled = false;
  }
}

async function loadHostUpload() {
  if (!hostUploadId) return;
  hostSetStatus('loading…', 'loading');
  const result = await hostLoad(hostUploadId, readHostMapping());
  if (!result) { hostSetStatus('load failed', 'bad'); return; }
  hostSetStatus(result.view.accepted ? 'loaded' : 'not accepted', result.view.accepted ? 'ok' : 'bad');
  renderHostPreview(result.view);
  await refreshHost();
}

// The mapping table: one row per SOURCE column (file order), including ignored/unrecognised ones —
// a column silently dropped is exactly how a file gets misread. `auto` marks a guess, `you` an
// explicit choice. Mirrors renderPutawayMapping.
function renderHostMapping(view) {
  const columns = Array.isArray(view?.columns) ? view.columns : [];
  const panel = document.getElementById('host-mapping');
  if (panel) panel.hidden = columns.length === 0;

  const body = document.getElementById('host-mapping-body');
  if (!body) return;
  body.replaceChildren(...columns.map((column) => {
    const tr = document.createElement('tr');
    const select = document.createElement('select');
    select.className = 'host-map-select';
    select.dataset.index = String(column.index);
    const ignore = document.createElement('option');
    ignore.value = 'Ignore';
    ignore.textContent = '— ignore —';
    select.append(ignore);
    for (const target of view.targets ?? []) {
      const option = document.createElement('option');
      option.value = target.name;
      option.textContent = target.isRequired ? `${target.name} (required)` : target.name;
      if (target.description) option.title = target.description;
      select.append(option);
    }
    // A target the catalogue does not list (already-bound but unknown) stays selectable so re-applying
    // a mapping cannot silently drop it.
    if (column.target && column.target !== 'Ignore'
      && ![...select.options].some((o) => o.value === column.target)) {
      const option = document.createElement('option');
      option.value = column.target;
      option.textContent = column.target;
      select.append(option);
    }
    select.value = column.target || 'Ignore';

    const origin = document.createElement('span');
    const label = column.origin === 'user' ? 'you' : column.origin === 'auto' ? 'auto' : '—';
    origin.className = `pill ${column.origin === 'user' ? 'ok' : column.origin === 'auto' ? 'loading' : ''}`.trim();
    origin.textContent = label;

    const target = document.createElement('td');
    target.append(select);
    const originCell = document.createElement('td');
    originCell.append(origin);
    tr.append(cell(column.source || '(unnamed)'), cell(column.firstValue ?? ''), target, originCell);
    return tr;
  }));
}

/** Collect the current dropdown state as an explicit, index-based mapping. Mirrors readPutawayMapping. */
function readHostMapping() {
  return [...document.querySelectorAll('#host-mapping-body .host-map-select')]
    .map((select) => ({ index: Number(select.dataset.index), target: select.value }));
}

// Render the upload/preview view: counts + delimiter/encoding/ignored note in #host-load-msg, errors
// in #host-errors, the mapping table, and a bounded sample grid. "Load to backlog" is enabled only
// when the parse was accepted.
function renderHostPreview(view) {
  const msg = document.getElementById('host-load-msg');
  const list = document.getElementById('host-errors');
  const preview = document.getElementById('host-preview');
  const load = document.getElementById('btn-host-load');

  if (!view) {
    if (msg) msg.textContent = 'Upload failed — the request could not be completed.';
    if (list) list.replaceChildren();
    if (preview) preview.hidden = true;
    document.getElementById('host-mapping')?.setAttribute('hidden', '');
    if (load) load.disabled = true;
    return;
  }

  const errors = view.errors ?? [];
  if (msg) {
    const ignored = view.ignoredColumns ?? [];
    const ignoredNote = ignored.length ? ` — read but not sent: ${ignored.join(', ')}` : '';
    msg.textContent = view.accepted
      ? `Ready: ${view.picklistCount} picklists / ${view.lineCount} lines (delimiter "${view.delimiter}", ${view.encoding})${ignoredNote}`
      : `Not accepted — ${errors.length} problem${errors.length === 1 ? '' : 's'}:`;
  }
  if (list) {
    list.replaceChildren(...errors.map((e) => h('li', {
      text: e.lineNumber > 0 ? `line ${e.lineNumber}: ${e.reason}` : e.reason,
    })));
  }

  renderHostMapping(view);

  if (preview) preview.hidden = false;
  const body = document.getElementById('host-rows-body');
  if (body) {
    const rows = view.sample ?? [];
    body.replaceChildren(...(rows.length
      ? rows.map((r) => {
          const tr = document.createElement('tr');
          tr.append(
            cell(r.picklistId ?? ''),
            cell(r.orderId ?? '—'),
            cell(r.productId ?? ''),
            cell(formatQuantity(r.quantity), 'num'),
            cell(String(r.lineId ?? ''), 'num'),
            cell(r.batch ?? '—'),
            cell(r.priority == null ? '—' : String(r.priority), 'num'),
          );
          return tr;
        })
      : [emptyRow(7, 'No rows.')]));

    // The preview is a bounded sample (no table virtualisation), so say so and reassure the user that
    // every line is loaded on confirm — mirrors Direct Putaway's "showing first N of total" note.
    const more = document.getElementById('host-rows-more');
    if (more) {
      const total = view.lineCount ?? rows.length;
      const truncated = total > rows.length;
      more.hidden = !truncated;
      more.textContent = truncated
        ? `Showing the first ${rows.length} of ${total} lines — all ${total} are loaded when you press “Load to backlog”.`
        : '';
    }
  }

  if (load) load.disabled = !view.accepted;
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
  document.getElementById('btn-host-upload')?.addEventListener('click', previewHostUpload);
  document.getElementById('btn-host-remap')?.addEventListener('click', remapHostUpload);
  document.getElementById('btn-host-load')?.addEventListener('click', loadHostUpload);
  // Choosing a new file abandons the previous upload: its uploadId and any mapping no longer apply.
  document.getElementById('host-csv')?.addEventListener('change', () => { hostUploadId = null; });
  document.getElementById('btn-host-reset')?.addEventListener('click', () => applyHostStatus(control('host/reset')));
  for (const id of ['host-enabled', 'host-wave-size', 'host-refill', 'host-timeout', 'host-loop']) {
    document.getElementById(id)?.addEventListener('change', postHostConfig);
  }
}

// --- Simulation Database Optimization rail icon (spec 0042) --------------------------------------
// Wasm has no server DB / putaway files / notify socket, so the recycle icon is a deliberate no-op and
// no ws/notify socket is opened. The toast stack stays empty; nothing errors.
function wireOptimizeNoop() {
  window.__optimize = () => { /* no-op in the in-browser demo (no server) */ };
  const btn = document.getElementById('rail-optimize');
  if (btn) btn.addEventListener('click', window.__optimize);
}

// --- boot ---------------------------------------------------------------------------------------
async function init() {
  wireControls();
  wireNav();
  wireRailMenu();
  wireShiftEditor();
  wireTrace();
  wireHost();
  wireConfig();
  wireOptimizeNoop();

  // Start the poll/tick loops FIRST: a failure while restoring the initial state must never leave the
  // dashboard rendered-but-frozen because the intervals were never created.
  connect();
  await renderVersion();
  applyMode((await apiGetJson('config'))?.mode); // brand the rail logo before any view is opened
  await loadStaffingFromServer();
  await loadTaskTypesFromServer(); // Load available task types for assignment dropdown
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
  console.error('dashboard boot failed', err);  setConn('offline', 'boot failed');
});
