/**
 * Map download / build progress (MAP_PROGRESS) for the start pin and generations,
 * and waiting for a turn: searches and map builds of every visitor take turns on the
 * server (phase 'queue', `ahead` of this one). Phase 'search' (the turn came) has no text.
 */

/**
 * Map progress text for the pin or a generation. The server sends MAP_PROGRESS
 * about once a second while downloading, which also re-renders the timer.
 */
export function mapProgressText(status) {
  if (!status) return null;
  if (status.phase === 'queue' || status.status === 'queue') return queueText(status.ahead);
  if (status.phase === 'download' || status.status === 'download') {
    const secs = status.startedAt ? Math.max(0, Math.round((Date.now() - status.startedAt) / 1000)) : 0;
    const tiles = status.total ? ` (${status.total} ${status.total === 1 ? 'tile' : 'tiles'})` : '';
    const mb = status.mb > 0 ? ` · ${status.mb.toFixed(1)} MB` : '';
    return `Getting map data${tiles}… ${secs} s${mb}`;
  }
  if (status.phase === 'build' || status.status === 'build') return 'Preparing roads…';
  return null;
}

/** "Waiting for another search to finish…" (ahead: searches before this one, including the running one). */
export function queueText(ahead) {
  const n = Number(ahead) || 0;
  if (n <= 1) return 'Waiting for another search to finish…';
  return `Waiting for other searches to finish (${n} ahead of yours)…`;
}

/** Progress state after a MAP_PROGRESS message (keeps when the download started). */
export function nextProgress(prev, message, extra = {}) {
  const startedAt = prev?.startedAt && (prev.phase === message.phase || prev.status === message.phase)
    ? prev.startedAt
    : Date.now();
  return { ...prev, ...extra, phase: message.phase, done: message.done, total: message.total,
    mb: message.mb ?? 0, ahead: message.ahead, startedAt };
}
