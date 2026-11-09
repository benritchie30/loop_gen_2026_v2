"""Custom search boundaries (boundary.py, graph_builder, areas.tiles_needed).

The made-up town of test_graph_builder: a 5 x 5 grid of streets, ~400 m blocks.

    cd backend
    python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import boundary  # noqa: E402
import graph_builder as gb  # noqa: E402
from areas import tiles_needed  # noqa: E402
from test_graph_builder import MAX_M, at, routes, town  # noqa: E402


def box_around(i0, j0, i1, j1, pad=0.15):
    """A box over grid rows i0..i1 and columns j0..j1 (a little beyond them)."""
    (w, s), (e, n) = at(i0 - pad, j0 - pad), at(i1 + pad, j1 + pad)
    return {'shape': 'box', 'south': s, 'west': w, 'north': n, 'east': e}


def build(pin, shapes, max_m=MAX_M):
    lng, lat = pin
    return gb.build_graph(town(), lat, lng, max_m, elevation=False, boundary={'shapes': shapes})


def road_at(G, point, within_m=5):
    """Does a road of G pass within `within_m` of point (lng, lat)?"""
    x, y = point
    return any(gb.haversine(x, y, px, py) <= within_m
               for _u, _v, d in G.edges(data=True) for px, py in d['geometry'].coords)


def inside_box(lng, lat, b):
    return b['west'] <= lng <= b['east'] and b['south'] <= lat <= b['north']


class BoundaryTests(unittest.TestCase):
    def test_only_roads_inside_are_kept_and_routes_stay_inside(self):
        left = box_around(0, 0, 4, 2)  # columns 0-2 of the grid
        G, start, _ = build(at(2, 1), [left])
        self.assertTrue(all(inside_box(d['x'], d['y'], left) for _, d in G.nodes(data=True)))
        found = routes(G, start)
        self.assertGreater(len(found), 0)
        for f in found:
            self.assertTrue(all(inside_box(x, y, left) for x, y in f['geometry']['coordinates']))

    def test_shapes_together_are_one_area(self):
        # An L: columns 0-2 (all rows) and rows 0-1 (all columns). The corner
        # rows 3-4, columns 3-4 is in neither.
        left, bottom = box_around(0, 0, 4, 2), box_around(0, 0, 1, 4)
        G, _, _ = build(at(1, 1), [left, bottom])
        self.assertTrue(road_at(G, at(0, 4)))  # only in the second box
        self.assertTrue(road_at(G, at(4, 0)))  # only in the first
        self.assertFalse(road_at(G, at(4, 4)))  # in neither
        self.assertFalse(road_at(G, at(3, 3.5)))

    def test_an_unreachable_part_of_the_boundary_is_dropped(self):
        # Two boxes no road inside joins: the start's side only.
        left, right = box_around(0, 0, 4, 1), box_around(0, 3, 4, 4)
        G, _, _ = build(at(2, 0), [left, right])
        self.assertTrue(road_at(G, at(2, 0.5)))
        self.assertFalse(road_at(G, at(2, 3.5)))

    def test_a_pin_outside_starts_on_the_nearest_road_inside(self):
        left = box_around(0, 0, 4, 2)
        G, start, _ = build(at(2, 3.6), [left])
        self.assertTrue(inside_box(G.nodes[start]['x'], G.nodes[start]['y'], left))

    def test_a_circle_and_a_freeform_shape(self):
        (lng, lat) = at(2, 2)
        circle = {'shape': 'circle', 'lat': lat, 'lng': lng, 'radiusM': 700}
        G, _, _ = build(at(2, 2), [circle])
        self.assertTrue(all(gb.haversine(lng, lat, d['x'], d['y']) <= 701 for _, d in G.nodes(data=True)))
        tri = {'shape': 'freeform', 'coordinates': [[at(-0.2, -0.2)[1], at(-0.2, -0.2)[0]],
                                                    [at(-0.2, 4.2)[1], at(-0.2, 4.2)[0]],
                                                    [at(4.2, -0.2)[1], at(4.2, -0.2)[0]]]}
        G2, _, _ = build(at(1, 1), [tri])
        self.assertNotIn(1044, G2)  # the grid's far corner (row 4, column 4) is outside the triangle

    def test_no_roads_inside(self):
        far = box_around(20, 20, 21, 21)
        with self.assertRaises(gb.BuildError):
            build(at(2, 2), [far])


class ShapesTests(unittest.TestCase):
    def test_normalize_keeps_valid_shapes_only(self):
        shapes = [
            {'shape': 'circle', 'lat': 35, 'lng': -80, 'radiusM': 0},
            {'shape': 'box', 'north': 35, 'south': 36, 'east': -80, 'west': -81},
            {'shape': 'freeform', 'coordinates': [[35, -80], [35.1, -80]]},
            {'shape': 'circle', 'lat': 'x', 'lng': -80, 'radiusM': 10},
        ]
        self.assertIsNone(boundary.normalize({'shapes': shapes}))
        self.assertIsNone(boundary.key(None))
        self.assertIsNone(boundary.key({'shapes': []}))

    def test_a_hand_made_boundary_is_capped(self):
        # The public server trusts no message (limits.py): junk is dropped, lists are cut.
        junk = {'shapes': ['x', None, 5, {'shape': 'circle', 'lat': 'nan', 'lng': 0, 'radiusM': 10},
                           {'shape': 'circle', 'lat': 95, 'lng': 0, 'radiusM': 10},
                           {'shape': 'circle', 'lat': 35, 'lng': -80, 'radiusM': 1e9},
                           {'shape': 'freeform', 'coordinates': 'abc'}]}
        self.assertIsNone(boundary.normalize(junk))
        self.assertIsNone(boundary.normalize({'shapes': 'not a list'}))
        many = {'shapes': [{'shape': 'circle', 'lat': 35, 'lng': -80, 'radiusM': 100 + i}
                           for i in range(boundary.MAX_SHAPES + 50)]}
        self.assertEqual(len(boundary.normalize(many)), boundary.MAX_SHAPES)
        ring = [[35 + i * 1e-5, -80 + (i % 2) * 1e-4] for i in range(boundary.MAX_RING_POINTS + 100)]
        [shape] = boundary.normalize({'shapes': [{'shape': 'freeform', 'coordinates': ring}]})
        self.assertEqual(len(shape['coordinates']), boundary.MAX_RING_POINTS)

    def test_key_is_the_same_for_the_same_shapes(self):
        b = {'name': 'A', 'shapes': [box_around(0, 0, 1, 1)]}
        same = {'name': 'B', 'id': 'x', 'shapes': [dict(box_around(0, 0, 1, 1))]}
        other = {'shapes': [box_around(0, 0, 2, 1)]}
        self.assertEqual(boundary.key(b), boundary.key(same))
        self.assertNotEqual(boundary.key(b), boundary.key(other))

    def test_tiles_only_where_the_boundary_is(self):
        lat, lng = 35.25, -80.85  # the middle of a 0.1-degree tile
        everything = tiles_needed(lat, lng, 30 * 1609.34)
        small = {'shapes': [{'shape': 'circle', 'lat': lat, 'lng': lng, 'radiusM': 500}]}
        self.assertGreater(len(everything), 1)
        self.assertEqual(tiles_needed(lat, lng, 30 * 1609.34, small), [(352, -809)])


if __name__ == '__main__':
    unittest.main()
