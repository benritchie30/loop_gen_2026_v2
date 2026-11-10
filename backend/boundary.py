"""Custom search boundaries.

A boundary is the area a generation's roads must lie in, drawn by the user
instead of the automatic one (every road within reach of the start). It is
a list of shapes, together one area (their union), in the same form as the
UI's painted areas:

    {"shapes": [{"shape": "circle", "lat": .., "lng": .., "radiusM": ..},
                {"shape": "box", "north": .., "south": .., "east": .., "west": ..},
                {"shape": "freeform", "coordinates": [[lat, lng], ...]}],
     "name": ..., "id": ...}           # name / id are the UI's, ignored here

The graph keeps only the roads inside it (graph_builder). No route of length
`max` can get farther than max/2 from its start, so map tiles are needed only
where the boundary and that reach overlap.
"""
import hashlib
import json
import math
from typing import Optional

import shapely
from shapely.geometry import Polygon, box as shapely_box
from shapely.ops import unary_union

from limits import MAX_RING_POINTS, MAX_SELECTIONS

EARTH_M_PER_DEG = 111320.0
CIRCLE_SIDES = 72
# A hand-made message cannot ask for more than the UI could draw (limits.py).
MAX_SHAPES = MAX_SELECTIONS
MAX_RADIUS_M = 500_000.0


def _circle(lat, lng, radius_m):
    """A circle as a polygon in degrees (lng, lat), round on the ground."""
    k = math.cos(math.radians(lat)) or 1e-9
    pts = []
    for i in range(CIRCLE_SIDES):
        t = 2 * math.pi * i / CIRCLE_SIDES
        pts.append((lng + radius_m * math.cos(t) / (EARTH_M_PER_DEG * k),
                    lat + radius_m * math.sin(t) / EARTH_M_PER_DEG))
    return Polygon(pts)


def _num(v, limit=None):
    v = float(v)
    if not math.isfinite(v) or (limit is not None and abs(v) > limit):
        raise ValueError('not a number')
    return v


def _lat(v):
    return _num(v, 90.0)


def _lng(v):
    return _num(v, 180.0)


def normalize(boundary) -> Optional[list]:
    """The boundary's valid shapes, rounded (~1 cm), in a fixed form; None when it has none."""
    if not isinstance(boundary, dict):
        return None
    out = []
    shapes = boundary.get('shapes')
    for s in (shapes if isinstance(shapes, list) else [])[:MAX_SHAPES]:
        try:
            kind = s.get('shape')
            if kind == 'circle':
                r = _num(s['radiusM'])
                if 0 < r <= MAX_RADIUS_M:
                    out.append({'shape': 'circle', 'lat': round(_lat(s['lat']), 7),
                                'lng': round(_lng(s['lng']), 7), 'radiusM': round(r, 2)})
            elif kind == 'box':
                n, so = _lat(s['north']), _lat(s['south'])
                e, w = _lng(s['east']), _lng(s['west'])
                if n > so and e > w:
                    out.append({'shape': 'box', 'north': round(n, 7), 'south': round(so, 7),
                                'east': round(e, 7), 'west': round(w, 7)})
            elif kind == 'freeform':
                ring = s.get('coordinates')
                pts = [[round(_lat(p[0]), 7), round(_lng(p[1]), 7)]
                       for p in (ring if isinstance(ring, list) else [])[:MAX_RING_POINTS]]
                if len(pts) >= 3:
                    out.append({'shape': 'freeform', 'coordinates': pts})
        except (AttributeError, KeyError, TypeError, ValueError, IndexError):
            continue
    return out or None


def key(boundary) -> Optional[str]:
    """Short id of a boundary's shapes (None: no boundary), for caching areas."""
    shapes = normalize(boundary)
    if not shapes:
        return None
    text = json.dumps(shapes, sort_keys=True, separators=(',', ':'))
    return hashlib.sha1(text.encode()).hexdigest()[:12]


def geometry(boundary):
    """The boundary as one shapely geometry in degrees (x = lng, y = lat), prepared; None: no boundary."""
    shapes = normalize(boundary)
    if not shapes:
        return None
    parts = []
    for s in shapes:
        if s['shape'] == 'circle':
            parts.append(_circle(s['lat'], s['lng'], s['radiusM']))
        elif s['shape'] == 'box':
            parts.append(shapely_box(s['west'], s['south'], s['east'], s['north']))
        else:
            poly = Polygon([(lng, lat) for lat, lng in s['coordinates']])
            if not poly.is_valid:
                poly = poly.buffer(0)  # a freehand shape that crosses itself
            parts.append(poly)
    geom = unary_union(parts)
    if geom.is_empty:
        return None
    shapely.prepare(geom)
    return geom


def contains(geom, xs, ys):
    """Which of the points (lng xs, lat ys; sequences) are inside: a list of bools."""
    return shapely.contains_xy(geom, list(xs), list(ys)).tolist()


def overlaps_box(geom, south, west, north, east) -> bool:
    return geom.intersects(shapely_box(west, south, east, north))
