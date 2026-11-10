"""Road surface from OSM tags: paved, unpaved, or unknown.

Unpaved is one class (gravel and dirt alike). `surface` decides when it is a
known value; otherwise `tracktype` (grade1 is solid, usually paved; grade2
gravel; grade3-5 softer) does. With neither, the surface is unknown, which
the app shows as paved: in OSM an untagged road (residential, tertiary...)
is nearly always paved, and only paths and tracks are often not.

A tag value can be a ';'-list ('gravel;asphalt'); the first known value
wins, as it is usually the main one.
"""
from typing import Optional

PAVED = 'paved'
UNPAVED = 'unpaved'
UNKNOWN = 'unknown'

PAVED_SURFACES = frozenset({
    'paved', 'asphalt', 'chipseal', 'concrete', 'concrete:plates', 'concrete:lanes',
    'paving_stones', 'paving_stones:lanes', 'sett', 'cobblestone', 'unhewn_cobblestone',
    'bricks', 'brick', 'metal', 'metal_grid', 'wood', 'rubber', 'tartan', 'grass_paver',
})
UNPAVED_SURFACES = frozenset({
    'unpaved', 'gravel', 'fine_gravel', 'compacted', 'pebblestone', 'rock', 'rocks', 'stone',
    'ground', 'dirt', 'earth', 'soil', 'mud', 'sand', 'clay', 'grass', 'woodchips',
    'shells', 'salt', 'snow', 'ice',
})
PAVED_TRACKTYPES = frozenset({'grade1'})
UNPAVED_TRACKTYPES = frozenset({'grade2', 'grade3', 'grade4', 'grade5'})


def _values(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        out = []
        for item in value:
            out.extend(_values(item))
        return out
    return [v.strip().lower() for v in str(value).split(';') if v.strip()]


def _first_known(values, paved, unpaved) -> Optional[str]:
    for v in values:
        if v in paved:
            return PAVED
        if v in unpaved:
            return UNPAVED
    return None


def classify(tags) -> str:
    """PAVED, UNPAVED or UNKNOWN for one way's tags."""
    if not tags:
        return UNKNOWN
    return (_first_known(_values(tags.get('surface')), PAVED_SURFACES, UNPAVED_SURFACES)
            or _first_known(_values(tags.get('tracktype')), PAVED_TRACKTYPES, UNPAVED_TRACKTYPES)
            or UNKNOWN)


def is_unpaved(tags) -> bool:
    return classify(tags) == UNPAVED


# ---- surface preference (the search) ----
#
# Costs are turn-equivalents per mile, like road stress (road_stress.py), but
# kept apart from it: they are not "discomfort" (the number on the cards) and
# short-crossing refunds never apply to them.
#   paved:  Paved only. A strong charge on unpaved roads (a busy trunk is 12
#           turns/mi), so routes take them only where nothing else connects.
#           Paths, bridleways and tracks with no surface tag are usually dirt:
#           they get a smaller charge.
#   allow:  Allow gravel (the default): surface does not matter.
#   gravel: Prefer gravel. Paved (and unknown) roads cost a little, so the
#           search goes out of its way for unpaved ones. (Costs cannot be
#           negative, so gravel is preferred by charging for everything else.)
SURFACE_PREFERENCES = ('paved', 'allow', 'gravel')
DEFAULT_PREFERENCE = 'allow'
UNPAVED_PENALTY = 25.0   # turns per mile on unpaved roads, Paved only
LIKELY_UNPAVED = 8.0     # turns per mile on untagged paths / bridleways / tracks, Paved only
PAVED_CHARGE = 2.0       # turns per mile on paved or unknown roads, Prefer gravel (in the search trees)
# Prefer gravel ranks loops by score x exp(-GRAVEL_RANK x unpaved share): a
# loop 30% unpaved scores ~4.5x better than an all-paved one (the pull for new
# areas is at most 3x), 10% unpaved ~1.6x. A big paved charge alone does not
# do it: on a network that is mostly paved it acts like a cost per mile and
# drowns the costs that spread routes out.
GRAVEL_RANK = 5.0
LIKELY_UNPAVED_HIGHWAYS = frozenset({'path', 'bridleway', 'track'})
# Paved only also drops a route with more unpaved road than this (a short
# unavoidable connector passes; a route with miles of gravel does not).
PAVED_ONLY_ALLOWANCE_M = 400.0
MILE_M = 1609.344


def resolve_preference(value) -> str:
    """'paved', 'allow' or 'gravel' (anything else: the default)."""
    v = str(value or '').strip().lower()
    return v if v in SURFACE_PREFERENCES else DEFAULT_PREFERENCE


def cost_per_mile(tags, preference) -> float:
    """Surface cost of one way's tags in turns per mile."""
    if preference == 'paved':
        kind = classify(tags)
        if kind == UNPAVED:
            return UNPAVED_PENALTY
        if kind == UNKNOWN and set(_values((tags or {}).get('highway'))) & LIKELY_UNPAVED_HIGHWAYS:
            return LIKELY_UNPAVED
        return 0.0
    if preference == 'gravel':
        return 0.0 if classify(tags) == UNPAVED else PAVED_CHARGE
    return 0.0


def edge_cost_per_m(data, preference) -> float:
    """Surface cost of a graph edge per metre: length-weighted over its parts
    (a merged road can be part gravel), else from its own tags."""
    if preference not in ('paved', 'gravel'):
        return 0.0
    parts = data.get('parts')
    if parts:
        total = sum(length for length, _tags in parts)
        if total > 0:
            return sum(cost_per_mile(tags, preference) * length for length, tags in parts) / total / MILE_M
    return cost_per_mile(data, preference) / MILE_M
