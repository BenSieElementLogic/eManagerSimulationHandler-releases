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
