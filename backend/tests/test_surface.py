"""Road surfaces: OSM tags to paved / unpaved / unknown (surface.py), and a
route's unpaved stretches (route_features.surface_properties).

    cd backend
    python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import surface  # noqa: E402
import graph_builder as gb  # noqa: E402
import route_features as rf  # noqa: E402
from tests.test_graph_builder import at, grid_node, town  # noqa: E402

MILE_M = 1609.344


class ClassifyTest(unittest.TestCase):
    def test_surface_tag(self):
        for value in ('asphalt', 'concrete', 'paved', 'chipseal', 'paving_stones', 'sett', 'wood'):
            self.assertEqual(surface.classify({'surface': value}), surface.PAVED, value)
        for value in ('gravel', 'fine_gravel', 'compacted', 'unpaved', 'dirt', 'ground', 'grass', 'sand', 'mud'):
            self.assertEqual(surface.classify({'surface': value}), surface.UNPAVED, value)

    def test_tracktype_when_no_known_surface(self):
        self.assertEqual(surface.classify({'highway': 'track', 'tracktype': 'grade1'}), surface.PAVED)
        for grade in ('grade2', 'grade3', 'grade5'):
            self.assertEqual(surface.classify({'tracktype': grade}), surface.UNPAVED, grade)
        # A known surface beats the track type.
        self.assertEqual(surface.classify({'surface': 'asphalt', 'tracktype': 'grade3'}), surface.PAVED)
        # An unknown surface value falls back to it.
        self.assertEqual(surface.classify({'surface': 'weird', 'tracktype': 'grade3'}), surface.UNPAVED)

    def test_untagged_is_unknown_and_shown_as_paved(self):
        self.assertEqual(surface.classify({'highway': 'residential'}), surface.UNKNOWN)
        self.assertEqual(surface.classify({}), surface.UNKNOWN)
        self.assertEqual(surface.classify(None), surface.UNKNOWN)
        self.assertFalse(surface.is_unpaved({'highway': 'path'}))

    def test_lists_and_case(self):
        self.assertEqual(surface.classify({'surface': 'Gravel;asphalt'}), surface.UNPAVED)
        self.assertEqual(surface.classify({'surface': 'weird;asphalt'}), surface.PAVED)
        self.assertEqual(surface.classify({'surface': ['dirt']}), surface.UNPAVED)


def half_gravel_town():
    """The town, with row 2's block between columns 1 and 2 half asphalt
    (west) and half gravel (east): two OSM ways meeting mid-block, which the
    builder merges into one edge of two parts."""
    ways = town()
    row2 = next(w for w in ways if w[0] == 102)
    way_id, nodes, coords, tags = row2
    i = nodes.index(grid_node(2, 1)) + 1  # the node mid-block east of column 1
    west = (way_id, nodes[:i + 1], coords[:i + 1], dict(tags, surface='asphalt'))
    east = (1102, nodes[i:], coords[i:], dict(tags, surface='gravel'))
    return [w for w in ways if w[0] != 102] + [west, east]


class RouteSurfaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        lng, lat = at(2, 2)
        cls.G, cls.start, _ = gb.build_graph(half_gravel_town(), lat, lng, 9000.0, elevation=False)
        cls.a, cls.b = grid_node(2, 1), grid_node(2, 2)

    def surfaces(self, u, v):
        return [tags.get('surface') for _length, tags in self.G[u][v][0]['parts']]

    def test_parts_run_the_way_the_edge_does(self):
        self.assertEqual(self.surfaces(self.a, self.b), ['asphalt', 'gravel'])
        self.assertEqual(self.surfaces(self.b, self.a), ['gravel', 'asphalt'])

    def test_unpaved_stretch_riding_east(self):
        feature = rf.path_to_geojson(self.G, [self.a, self.b], {})
        coords = feature['geometry']['coordinates']
        self.assertEqual(len(coords), 3)  # column 1, mid-block, column 2
        (i0, i1, d0, d1), = feature['properties']['unpaved']
        self.assertEqual((i0, i1), (1, 2))  # from mid-block to column 2
        half = self.G[self.a][self.b][0]['length'] / 2 / MILE_M
        self.assertAlmostEqual(d0, half, delta=0.002)
        self.assertAlmostEqual(d1, 2 * half, delta=0.002)
        self.assertAlmostEqual(feature['properties']['unpaved_miles'], half, delta=0.002)

    def test_unpaved_stretch_riding_west(self):
        feature = rf.path_to_geojson(self.G, [self.b, self.a], {})
        (i0, i1, d0, d1), = feature['properties']['unpaved']
        self.assertEqual((i0, i1), (0, 1))  # from column 2 to mid-block
        self.assertAlmostEqual(d0, 0.0, delta=0.002)
        self.assertAlmostEqual(d1, self.G[self.a][self.b][0]['length'] / 2 / MILE_M, delta=0.002)

    def test_stretches_on_consecutive_edges_join(self):
        # East from column 1 to column 3: gravel from mid-block on, across column 2.
        c = grid_node(2, 3)
        feature = rf.path_to_geojson(self.G, [self.a, self.b, c], {})
        runs = feature['properties']['unpaved']
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0][:2], [1, len(feature['geometry']['coordinates']) - 1])

    def test_paved_route_has_none(self):
        feature = rf.path_to_geojson(self.G, [grid_node(1, 1), grid_node(1, 2)], {})
        self.assertEqual(feature['properties']['unpaved'], [])
        self.assertEqual(feature['properties']['unpaved_miles'], 0)


class PreferenceCostTest(unittest.TestCase):
    def test_names(self):
        self.assertEqual(surface.resolve_preference('paved'), 'paved')
        self.assertEqual(surface.resolve_preference('GRAVEL'), 'gravel')
        self.assertEqual(surface.resolve_preference(None), 'allow')
        self.assertEqual(surface.resolve_preference('bogus'), 'allow')

    def test_costs_per_mile(self):
        gravel, asphalt, residential = {'surface': 'gravel'}, {'surface': 'asphalt'}, {'highway': 'residential'}
        path = {'highway': 'path'}
        # Paved only: a strong charge on unpaved, a smaller one on untagged paths, none on roads.
        self.assertEqual(surface.cost_per_mile(gravel, 'paved'), surface.UNPAVED_PENALTY)
        self.assertEqual(surface.cost_per_mile(path, 'paved'), surface.LIKELY_UNPAVED)
        self.assertEqual(surface.cost_per_mile(residential, 'paved'), 0)
        self.assertEqual(surface.cost_per_mile(dict(path, surface='asphalt'), 'paved'), 0)
        # Prefer gravel: paved and unknown cost a little, unpaved nothing.
        self.assertEqual(surface.cost_per_mile(gravel, 'gravel'), 0)
        self.assertEqual(surface.cost_per_mile(asphalt, 'gravel'), surface.PAVED_CHARGE)
        self.assertEqual(surface.cost_per_mile(residential, 'gravel'), surface.PAVED_CHARGE)
        # Allow gravel: nothing.
        for tags in (gravel, asphalt, path):
            self.assertEqual(surface.cost_per_mile(tags, 'allow'), 0)

    def test_a_merged_edge_is_length_weighted(self):
        data = {'parts': [(300.0, {'surface': 'gravel'}), (100.0, {'surface': 'asphalt'})]}
        self.assertAlmostEqual(surface.edge_cost_per_m(data, 'paved') * MILE_M, 0.75 * surface.UNPAVED_PENALTY)
        self.assertAlmostEqual(surface.edge_cost_per_m(data, 'gravel') * MILE_M, 0.25 * surface.PAVED_CHARGE)
        self.assertEqual(surface.edge_cost_per_m(data, 'allow'), 0)


def gravel_column_town():
    """The town, with column 1 a quiet gravel lane end to end and every other
    street a busy primary road: without a surface preference, routes want the lane."""
    return [(w[0], w[1], w[2], dict(w[3], surface='gravel') if w[0] == 201 else dict(w[3], highway='primary'))
            for w in town()]


class PreferenceSearchTest(unittest.TestCase):
    """The search on a town whose one quiet street (column 1) is gravel."""

    @classmethod
    def setUpClass(cls):
        from loop_generator import find_paths
        from loop_tree import is_idle, edge_table
        lng, lat = at(2, 2)
        cls.G, cls.start, _ = gb.build_graph(gravel_column_town(), lat, lng, 9000.0, elevation=False)
        cls.E = edge_table(cls.G)

        def search(pref, n=8):
            out = []
            for item in find_paths(cls.G, cls.start, min_path_length=3000, max_path_length=9000,
                                   loop_ratio_floor=0.5, min_loop_length=600, surface_preference=pref):
                if is_idle(item):
                    break
                out.append(item)
                if len(out) >= n:
                    break
            return out
        cls.features = staticmethod(search)
        cls.search = staticmethod(lambda pref, n=8: [f['properties'] for f in search(pref, n)])

    def test_the_graph_knows_its_gravel(self):
        self.assertGreater(sum(self.E.unpaved_m), 1500)  # column 1: ~1.6 km

    def test_allow_is_the_default(self):
        self.assertEqual([p['total_miles'] for p in self.search('allow')], [p['total_miles'] for p in self.search(None)])

    def test_paved_only_keeps_off_gravel(self):
        routes = self.search('paved')
        self.assertTrue(routes)
        for p in routes:
            self.assertLessEqual(p['unpaved_miles'] * MILE_M, surface.PAVED_ONLY_ALLOWANCE_M + 1)
        self.assertTrue(any(p['unpaved_miles'] > 0.3 for p in self.search('allow')), 'allow uses the gravel street')

    def test_prefer_gravel_lists_gravel_loops_first(self):
        routes = self.search('gravel')
        self.assertGreater(routes[0]['unpaved_miles'], 0)
        share = lambda ps: sum(p['unpaved_miles'] / p['total_miles'] for p in ps[:3]) / 3
        self.assertGreater(share(routes), share(self.search('allow')))

    def test_discomfort_does_not_include_the_surface_cost(self):
        # Prefer gravel charges every paved road; discomfort is still road stress alone, the
        # same for a route whichever preference found it.
        by_shape = {}
        for pref in ('allow', 'gravel', 'paved'):
            for f in self.features(pref):
                key = tuple(map(tuple, f['geometry']['coordinates']))
                by_shape.setdefault(key, set()).add(round(f['properties']['discomfort'], 3))
        self.assertGreater(len(by_shape), 8)
        self.assertTrue(all(len(v) == 1 for v in by_shape.values()))


if __name__ == '__main__':
    unittest.main()
