// Pure, DOM-free render/format helpers for the dashboard (spec 0008). Kept side-effect free so they
// are unit-testable under `node --test` and reusable by the live render layer in app.js.

/** Parse a .NET TimeSpan wire value ("hh:mm:ss(.fffffff)") or a raw number of seconds into seconds. */
export function parseTimeSpanSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  // Optional leading "d." day part, then hh:mm:ss with optional fractional seconds.
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) {
    return 0;
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/** Format a duration (TimeSpan string or seconds) as "X.Xs" under a minute, else "Mm SSs". */
export function formatDuration(value) {
  const total = parseTimeSpanSeconds(value);
  if (total < 60) {
    return `${total.toFixed(1)}s`;
  }
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Coerce any value to a safe non-negative integer string (defaults to 0). */
export function formatCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.trunc(n)) : '0';
}

/** Format a throughput (missions/hour) to one decimal place. */
export function formatThroughput(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(1);
}

/** Format a 0..1 fraction as a whole-number percentage string. */
export function formatPercent(value) {
  const n = Number(value);
  return `${Math.round((Number.isFinite(n) ? n : 0) * 100)}%`;
}

/** Muse pill descriptor for a port's open/closed state. */
export function portStatusPill(isOpen) {
  return isOpen ? { cls: 'ok', text: 'Open' } : { cls: 'bad', text: 'Closed' };
}

/** Muse pill descriptor for a mission-activity state. */
export function missionStatePill(state) {
  switch (state) {
    case 'completed':
      return { cls: 'ok', text: 'completed' };
    case 'failed':
      return { cls: 'bad', text: 'failed' };
    default:
      return { cls: 'warn', text: 'in-progress' };
  }
}

/** Format a mission quantity (decimal) as a compact string; blank ("—") for missing/invalid. */
export function formatQuantity(value) {
  if (value === null || value === undefined) {
    return '—';
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return '—';
  }
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}

/**
 * Map a stats snapshot's real per-mission activity log to display rows for the missions panel.
 * The snapshot carries `recentMissions` (newest first) with genuine kind/quantity/state/timestamp
 * per mission — no reconstruction from counter deltas. State is lower-cased for the pill helper.
 */
export function missionActivities(snapshot) {
  const list = snapshot && Array.isArray(snapshot.recentMissions) ? snapshot.recentMissions : [];
  return list.map((m) => ({
    kind: m.kind,
    portCode: m.portCode,
    quantity: m.quantity,
    state: String(m.state ?? '').toLowerCase(),
    at: m.timestamp,
  }));
}

/**
 * Extrapolate the virtual simulation clock locally between server pushes. `anchor` is
 * `{ simMs, atMs, running, speed }`: the virtual time the server reported (`simMs`) at the LOCAL instant
 * `atMs`, so the elapsed delta is skew-free. At a speed factor > 1 the virtual clock advances that many
 * times faster than the local one — without scaling here the display would drift ~19 virtual seconds per
 * real second at x20. Frozen while the simulation is stopped; a missing anchor falls back to real time.
 */
export function virtualNow(anchor, nowMs) {
  if (!anchor) {
    return nowMs;
  }
  if (!anchor.running) {
    return anchor.simMs;
  }
  return anchor.simMs + (nowMs - anchor.atMs) * (anchor.speed ?? 1);
}

/**
 * Coverage of a shift's assignments against the ports the eManager reported (spec 0012):
 * `{ total, staffed, unstaffed }`. Port codes match case-insensitively, an assignment naming a port
 * that was not discovered is ignored (it neither raises `staffed` nor appears in `unstaffed`), a port
 * assigned twice still counts once, and null/undefined inputs are treated as empty.
 */
export function staffingCoverage(portCodes, assignments) {
  const codes = Array.isArray(portCodes) ? portCodes.filter((c) => c != null && c !== '') : [];
  const list = Array.isArray(assignments) ? assignments : [];
  const assigned = new Set(list.map((a) => String(a?.port ?? '').toLowerCase()).filter(Boolean));
  const unstaffed = codes.filter((c) => !assigned.has(String(c).toLowerCase()));
  return { total: codes.length, staffed: codes.length - unstaffed.length, unstaffed };
}

/** Pluralise a count: `3 rows`, `1 row`. */
function countLabel(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * One-line summary of a parsed putaway CSV (spec 0015): how much was understood, how it was
 * understood (delimiter/encoding — both auto-detected and both worth showing before a write into a
 * live warehouse), and the batch reference that decides whether a re-send is idempotent.
 */
export function putawaySummary(result) {
  const r = result ?? {};
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  const delimiter = r.delimiter === '\t' ? 'tab' : r.delimiter ? `'${r.delimiter}'` : 'unknown';
  return [
    countLabel(len(r.rows), 'row'),
    countLabel(len(r.errors), 'error'),
    countLabel(len(r.warnings), 'warning'),
    `delimiter ${delimiter}`,
    `encoding ${r.encodingName || 'unknown'}`,
    `reference ${r.batchReference || '—'}`,
  ].join(' · ');
}

/**
 * The live counter line for a running/finished batch. "already stored" (the eManager's 409) is kept
 * as its own figure: it is a SUCCESS — it is what makes re-running a file the safe recovery action —
 * so folding it into stored or into failed would misreport every idempotent retry.
 */
export function batchCounters(progress) {
  const p = progress ?? {};
  const n = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  return `${n(p.sent)} / ${n(p.total)} sent · ${n(p.stored)} stored · ${n(p.alreadyStored)} already stored`
    + ` · ${n(p.rejected)} rejected · ${n(p.failed)} failed`;
}

/**
 * One-line summary of how a putaway CSV's columns were understood (spec 0018). The address mode leads,
 * and it names the source column that carries it: a file addressed by BIN NUMBER goes somewhere quite
 * different from one addressed by LOCATION CODE, and mistaking one for the other is the whole reason
 * this mapping exists.
 */
export function mappingSummary(result) {
  const mapping = result?.mapping ?? {};
  const columns = Array.isArray(mapping.columns) ? mapping.columns : [];
  const mode = mapping.addressMode;
  const carrier = columns.find((c) => c?.target === (mode === 'Bin' ? 'BinId' : 'LocationCode'));
  const addressing = mode === 'Bin' || mode === 'LocationCode'
    ? `${mode === 'Bin' ? 'bin number' : 'location code'} ('${carrier?.source ?? '—'}')`
    : 'no address column mapped';
  const mapped = columns.filter((c) => c?.target && c.target !== 'Ignore').length;
  const ignored = columns.length - mapped;
  return `Addressing: ${addressing} · ${countLabel(mapped, 'column')} mapped · ${ignored} ignored`;
}
