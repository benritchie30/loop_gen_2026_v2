import { describe, expect, it } from 'vitest';
import { mapProgressText, nextProgress, queueText } from '../mapProgress';

describe('waiting for a turn on the server (MAP_PROGRESS phase queue)', () => {
  it('says how many searches are ahead', () => {
    expect(queueText(1)).toBe('Waiting for another search to finish…');
    expect(queueText(0)).toBe('Waiting for another search to finish…');
    expect(queueText(3)).toBe('Waiting for other searches to finish (3 ahead of yours)…');
  });

  it('a generation shows the queue, then nothing once its turn comes (Finding routes… takes over)', () => {
    let status = nextProgress(undefined, { phase: 'queue', ahead: 2, done: 2, total: 0 });
    expect(mapProgressText(status)).toBe('Waiting for other searches to finish (2 ahead of yours)…');
    status = nextProgress(status, { phase: 'queue', ahead: 1, done: 1, total: 0 });
    expect(mapProgressText(status)).toBe('Waiting for another search to finish…');
    status = nextProgress(status, { phase: 'search', done: 0, total: 0 });
    expect(mapProgressText(status)).toBeNull();
  });

  it('the start pin (status field) shows it too, then the build', () => {
    let pin = nextProgress({ lat: 1, lng: 2 }, { phase: 'queue', ahead: 1 }, { status: 'queue' });
    expect(mapProgressText(pin)).toBe('Waiting for another search to finish…');
    pin = nextProgress(pin, { phase: 'build', done: 0, total: 1 }, { status: 'build' });
    expect(mapProgressText(pin)).toBe('Preparing roads…');
  });
});
