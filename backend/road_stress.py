"""Per-meter ride stress in turn-equivalents, from OSM highway tags.

Stress is added to the turn count during pleasant search. A residential mile
costs nothing; a primary mile costs 4 turns. Short crossings are capped later
by the search, not here.
"""
import re

MILE_M = 1609.0
CROSSING_MAX_M = 160.0
CROSSING_CAP = 0.15  # turn-equivalents charged for a short worse-road crossing
RURAL_FREE_SHARE = 0.35
RURAL_SCALE = 0.4

# Turn-equivalents per mile. Missing highway tags stay free; unknown class
# strings are priced like `road`.
_TURNS_PER_MILE = {
    'residential': 0.0,
    'living_street': 0.0,
    'tertiary': 0.0,
    'tertiary_link': 0.0,
    'unclassified': 0.0,
    'cycleway': 0.0,
    'path': 0.0,
    'pedestrian': 0.0,
    'bridleway': 0.0,
    'secondary': 1.0,
    'road': 1.0,
    'secondary_link': 1.5,
    'primary': 4.0,
    'primary_link': 5.0,
    'trunk': 12.0,
    'trunk_link': 12.0,
}

_CYCLEWAY_KEYS = ('cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both')
_REAL_FACILITY = {'lane', 'track', 'opposite_lane', 'opposite_track', 'separate'}
_SHARROW = {'shared_lane', 'share_busway'}
_NO_BIKE = {'no', 'dismount'}

_NUM_RE = re.compile(r'(\d+(?:\.\d+)?)')


def _tag_values(value):
    """Flatten a tag that may be a string, a ';'-list, or a list of those."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            out.extend(_tag_values(item))
        return out
    text = str(value).strip().lower()
    if not text:
        return []
    if ';' in text:
        return [part.strip() for part in text.split(';') if part.strip()]
    return [text]


def _turns_per_mile(highway_tag):
    if highway_tag in _TURNS_PER_MILE:
        return _TURNS_PER_MILE[highway_tag]
    return 1.0


def _cycleway_factor(data):
    values = []
    for key in _CYCLEWAY_KEYS:
        values.extend(_tag_values(data.get(key)))
    if any(v in _REAL_FACILITY for v in values):
        return 0.25
    if any(v in _SHARROW for v in values):
        return 0.6
    return 1.0


def _first_number(value):
    for item in _tag_values(value):
        match = _NUM_RE.search(item)
        if match:
            return float(match.group(1))
    return None


def _maxspeed_kmh(value):
    best = None
    for item in _tag_values(value):
        match = _NUM_RE.search(item)
        if not match:
            continue
        num = float(match.group(1))
        kmh = num * 1.60934 if 'mph' in item else num
        if best is None or kmh > best:
            best = kmh
    return best


def edge_stress(data):
    """Turn-equivalents per meter for one edge, before the rural scale."""
    highways = _tag_values(data.get('highway'))
    if not highways:
        base = 0.0
    else:
        base = max(_turns_per_mile(h) for h in highways) / MILE_M

    if base > 0:
        base *= _cycleway_factor(data)
        lanes = _first_number(data.get('lanes'))
        if lanes is not None:
            if lanes >= 6:
                base *= 2.0
            elif lanes >= 4:
                base *= 1.5
        speed = _maxspeed_kmh(data.get('maxspeed'))
        if speed is not None:
            # 50 mph ≈ 80.5 km/h; 25 mph ≈ 40.2 km/h. Include both the
            # round km/h cutoffs and those exact mph values.
            if speed >= 80:
                base *= 1.5
            elif speed <= 40.3:
                base *= 0.7
        return base

    if any(v in _NO_BIKE for v in _tag_values(data.get('bicycle'))):
        return 1.0 / MILE_M
    return 0.0


def annotate_edge_stress(G):
    """Write `stress` on every edge. Scales busy roads down on rural graphs.

    Rural: if free edges (stress 0) are under 35% of length, multiply every
    positive stress by 0.4. Idempotent: each call recomputes from tags.
    """
    for _u, _v, _k, data in G.edges(keys=True, data=True):
        data['stress'] = edge_stress(data)

    total = 0.0
    free = 0.0
    for _u, _v, _k, data in G.edges(keys=True, data=True):
        length = float(data.get('length') or 0)
        total += length
        if not data.get('stress'):
            free += length

    if total > 0 and (free / total) < RURAL_FREE_SHARE:
        for _u, _v, _k, data in G.edges(keys=True, data=True):
            stress = data.get('stress') or 0
            if stress > 0:
                data['stress'] = stress * RURAL_SCALE
    return G
