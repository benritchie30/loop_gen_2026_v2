"""Search graphs ("areas") around a start, built from map tiles on demand.

An area is the graph for one start point, one maximum route length and,
optionally, a custom boundary (boundary.py). It needs the tiles within
max/2 + margin of the start (with a boundary, only those it overlaps; map_store)
and is built by graph_builder in a few seconds, so nothing is saved: recent
areas stay in memory and an area built for a longer max serves a shorter one
(with the same boundary).
"""
import itertools
import secrets
import threading
import time
from typing import Callable, Dict, List, Optional

import boundary as boundary_mod
import graph_builder
from limits import env_number
from map_store import MapError, MapStore, tile_bbox, tiles_for_circle

# Built graphs kept in memory. A 50 mi area in a dense city is several hundred MB
# (a 10 mi one in Charlotte: ~4k nodes, ~60 MB), so on a 4 GB server keep a few.
MAX_AREAS = env_number('LOOP_MAX_AREAS', 4, lo=1)
REUSE_UP_TO = 1.6      # an area built for max M serves requests down to M / this
SAME_START_DEG = 1e-4  # about 10 m: same pin


class Area:
    __slots__ = ('id', 'lat', 'lng', 'max_m', 'G', 'start', 'stats', 'tiles', 'used', 'boundary_key')

    def __init__(self, area_id, lat, lng, max_m, G, start, stats, tiles, boundary_key=None):
        self.id, self.lat, self.lng, self.max_m = area_id, lat, lng, max_m
        self.G, self.start, self.stats, self.tiles = G, start, stats, tiles
        self.used = time.time()
        self.boundary_key = boundary_key

    def starts_at(self, lat, lng) -> bool:
        """Is (lat, lng) this area's pin, or the start it snapped to? (The UI
        moves the pin onto the start, and asks again from there.)"""
        node = self.G.nodes[self.start]
        return any(abs(y - lat) <= SAME_START_DEG and abs(x - lng) <= SAME_START_DEG
                   for y, x in ((self.lat, self.lng), (node['y'], node['x'])))

    def info(self) -> dict:
        x, y = self.G.nodes[self.start]['x'], self.G.nodes[self.start]['y']
        return {'areaId': self.id, 'lat': self.lat, 'lng': self.lng,
                'maxMiles': round(self.max_m / 1609.34, 2),
                'start': {'lat': y, 'lng': x},
                'nodes': self.stats.get('nodes'), 'edges': self.stats.get('edges'),
                'buildSeconds': self.stats.get('seconds')}


def tiles_needed(lat: float, lng: float, max_m: float, boundary: Optional[dict] = None) -> list:
    """Map tiles an area needs: within reach of the start, and (with a
    boundary) overlapping it. No route can use a road beyond either."""
    tiles = tiles_for_circle(lat, lng, max_m / 2.0 + graph_builder.MARGIN_M)
    geom = boundary_mod.geometry(boundary) if boundary else None
    if geom is None:
        return tiles
    return [t for t in tiles if boundary_mod.overlaps_box(geom, *tile_bbox(t))]


class Areas:
    def __init__(self, store: MapStore, queue=None):
        self.store = store
        self.queue = queue  # work_queue.WorkQueue: builds take turns with searches
        self._lock = threading.Lock()
        self._areas: List[Area] = []
        self._by_id: Dict[str, Area] = {}
        self._ids = itertools.count(1)
        self._tag = secrets.token_hex(2)  # ids never repeat across server restarts
        self._building: Dict[tuple, threading.Lock] = {}

    def by_id(self, area_id: str) -> Optional[Area]:
        with self._lock:
            return self._by_id.get(area_id)

    def _find(self, lat, lng, max_m, boundary_key=None) -> Optional[Area]:
        for a in self._areas:
            if (a.boundary_key == boundary_key and a.starts_at(lat, lng)
                    and max_m <= a.max_m <= max_m * REUSE_UP_TO):
                return a
        return None

    def cached(self, lat, lng, max_m, boundary: Optional[dict] = None) -> Optional[Area]:
        with self._lock:
            a = self._find(lat, lng, max_m, boundary_mod.key(boundary))
            if a is not None:
                a.used = time.time()
            return a

    def get(self, lat: float, lng: float, max_m: float,
            progress: Optional[Callable[[str, int, int], None]] = None,
            should_stop: Optional[Callable[[], bool]] = None,
            hold: bool = True, priority: Optional[float] = None,
            boundary: Optional[dict] = None) -> Optional[Area]:
        """The area for this start and max, downloading and building as needed.

        progress(phase, done, total, mb): phase 'download' (tiles landed, MB
        received by the running request), then 'build'.
        Returns None if should_stop fired (or, with hold=False, a download was
        cancelled). Raises MapError / BuildError. Blocking: call from a worker
        thread. hold=False is for prefetches (see MapStore.ensure). priority:
        when the visitor's request arrived (its place in the work queue).
        boundary: a custom search boundary (boundary.py), or None.
        """
        bkey = boundary_mod.key(boundary)
        got = self.cached(lat, lng, max_m, boundary)
        if got is not None:
            return got
        tiles = tiles_needed(lat, lng, max_m, boundary)
        if not tiles:
            raise graph_builder.BuildError('The boundary is out of reach of this start.')
        ok = self.store.ensure(
            tiles, progress=(lambda d, t, mb: progress('download', d, t, mb)) if progress else None,
            should_stop=should_stop, hold=hold)
        if not ok:
            return None

        key = (round(lat / SAME_START_DEG), round(lng / SAME_START_DEG), round(max_m), bkey)
        with self._lock:
            build_lock = self._building.setdefault(key, threading.Lock())
        with build_lock:  # one build per key; a second caller reuses it
            got = self.cached(lat, lng, max_m, boundary)
            if got is not None:
                return got
            if should_stop and should_stop():
                return None
            if self.queue is not None:
                waiting = (lambda ahead: progress('queue', ahead, 0)) if progress else None
                if not self.queue.acquire(should_stop=should_stop, on_wait=waiting, priority=priority):
                    return None
            try:
                got = self.cached(lat, lng, max_m, boundary)  # built by someone else while this one waited
                if got is not None:
                    return got
                if progress:
                    progress('build', 0, 1)
                G, start, stats = graph_builder.build_graph(self.store.ways(tiles), lat, lng, max_m,
                                                            boundary=boundary)
            finally:
                if self.queue is not None:
                    self.queue.release()
            area = Area(f'a{self._tag}-{next(self._ids)}', lat, lng, max_m, G, start, stats, tiles, bkey)
            print(f"[areas] {area.id}: {stats['nodes']} nodes, {stats['edges']} edges from "
                  f"{len(tiles)} tiles in {stats['seconds']}s {stats['timing']}")
            with self._lock:
                self._areas.append(area)
                self._by_id[area.id] = area
                while len(self._areas) > MAX_AREAS:
                    old = min(self._areas, key=lambda a: a.used)
                    self._areas.remove(old)
                    # Sessions keep their own reference; the id stops resolving.
                    self._by_id.pop(old.id, None)
                self._building.pop(key, None)
            if progress:
                progress('build', 1, 1)
            return area

    def drop_idle(self, idle_s: float) -> list:
        """Forget areas unused for idle_s seconds (sessions that still hold one
        keep it until they go too). Returns the dropped areas' ids."""
        cutoff = time.time() - idle_s
        with self._lock:
            old = [a for a in self._areas if a.used < cutoff]
            for a in old:
                self._areas.remove(a)
                self._by_id.pop(a.id, None)
        return [a.id for a in old]

    def __len__(self):
        with self._lock:
            return len(self._areas)


__all__ = ['Area', 'Areas', 'MapError', 'tiles_needed']
