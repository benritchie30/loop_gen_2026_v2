"""Where a start joins the roads (graph_builder.build_graph).

A made-up town: a 5 x 5 grid of residential streets (about 400 m blocks, a
node in the middle of every block), with dead-end streets off its edges.

    cd backend
    python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import graph_builder as gb  # noqa: E402
from loop_generator import find_paths  # noqa: E402
from loop_tree import is_idle  # noqa: E402

LAT0, LNG0, STEP = 35.0, -80.0, 0.004  # grid origin and spacing (degrees)
RES = {'highway': 'residential'}


def grid_node(i, j):
    return 1000 + i * 10 + j


def at(i, j):
    """(lng, lat) of grid point row i, column j (fractions allowed)."""
    return (LNG0 + j * STEP, LAT0 + i * STEP)


def town(extra=()):
    """Ways of the grid (rows and columns, with a node mid-block) plus `extra`."""
    ways, mid = [], 5000
    for i in range(5):  # rows
        nodes, coords = [], []
        for j in range(5):
            if j:
                mid += 1
                nodes.append(mid)
                coords.append(at(i, j - 0.5))
            nodes.append(grid_node(i, j))
            coords.append(at(i, j))
        ways.append((100 + i, nodes, coords, dict(RES, name=f'Row {i}')))
    for j in range(5):  # columns
        nodes, coords = [], []
        for i in range(5):
            if i:
                mid += 1
                nodes.append(mid)
                coords.append(at(i - 0.5, j))
            nodes.append(grid_node(i, j))
            coords.append(at(i, j))
        ways.append((200 + j, nodes, coords, dict(RES, name=f'Column {j}')))
    return ways + list(extra)


# A dead-end street east off row 2 (three pieces, 9003 is its end), with a
# short dead end of its own off 9002.
DEAD_END = (300, [grid_node(2, 4), 9001, 9002, 9003],
            [at(2, 4), at(2, 4.5), at(2, 5), at(2, 5.5)], dict(RES, name='Cul-de-sac'))
SIDE = (301, [9002, 9101], [at(2, 5), at(2.4, 5)], dict(RES, name='Side lane'))
# A one-way dead end west off row 2: a loop can leave its end but not come back.
ONE_WAY = (302, [9203, 9202, grid_node(2, 0)], [at(2, -1), at(2, -0.5), at(2, 0)],
           dict(RES, name='One way out', oneway='yes'))

# A footpath in a park south of row 0, joined to no rideable road: nearer
# the pin than any street, but no loop can start on it.
PARK_PATH = (303, [9301, 9302], [at(-0.3, 1.2), at(-0.3, 1.8)], {'highway': 'path'})

MAX_M = 9000.0


def build(lat_lng, extra=()):
    lng, lat = lat_lng
    return gb.build_graph(town(extra), lat, lng, MAX_M, elevation=False)


def routes(G, start, n=5):
    out = []
    for item in find_paths(G, start, min_path_length=3000, max_path_length=MAX_M,
                           loop_ratio_floor=0.5, min_loop_length=600):
        if is_idle(item):
            break
        out.append(item)
        if len(out) >= n:
            break
    return out


class StartTests(unittest.TestCase):
    def test_start_at_the_end_of_a_dead_end(self):
        G, start, stats = build(at(2, 5.5), [DEAD_END, SIDE])
        self.assertEqual(start, 9003)
        self.assertTrue(stats['start_snapped'])
        # One road out, and back: the dead end is the stem of every route.
        self.assertEqual(set(G.successors(start)), set(G.predecessors(start)))
        self.assertEqual(G.out_degree(start), 1)
        # The side lane off the dead end is still pruned.
        self.assertNotIn(9101, G)

    def test_routes_begin_and_end_at_a_dead_end_start(self):
        G, start, _ = build(at(2, 5.5), [DEAD_END, SIDE])
        found = routes(G, start)
        self.assertGreater(len(found), 0)
        end = [G.nodes[start]['x'], G.nodes[start]['y']]
        for feature in found:
            coords = feature['geometry']['coordinates']
            self.assertAlmostEqual(coords[0][0], end[0], places=9)
            self.assertAlmostEqual(coords[0][1], end[1], places=9)
            self.assertAlmostEqual(coords[-1][0], end[0], places=9)
            self.assertAlmostEqual(coords[-1][1], end[1], places=9)

    def test_start_in_the_middle_of_a_block(self):
        # Pin beside the middle of row 1 between columns 2 and 3: the start is
        # the node there, not the nearest corner.
        lng, lat = at(1, 2.5)
        G, start, stats = build((lng, lat + 0.0002))
        self.assertTrue(stats['start_snapped'])
        self.assertAlmostEqual(G.nodes[start]['x'], lng, places=9)
        self.assertAlmostEqual(G.nodes[start]['y'], lat, places=9)
        self.assertGreater(len(routes(G, start)), 0)

    def test_start_nearest_the_pin_on_the_nearest_road(self):
        # Pin a little off the dead end, nearer its middle node than any corner.
        lng, lat = at(2, 4.9)
        G, start, _ = build((lng, lat - 0.0003), [DEAD_END])
        self.assertEqual(start, 9002)

    def test_a_path_no_road_joins_is_skipped_for_the_nearest_street(self):
        # Pin on the park path's middle: row 0's middle node (between columns 1
        # and 2) is the nearest point of a street that loops can start from.
        lng, lat = at(-0.3, 1.5)
        G, start, stats = build((lng, lat), [PARK_PATH])
        self.assertNotIn(9301, G)
        self.assertTrue(stats['start_snapped'])
        self.assertAlmostEqual(G.nodes[start]['x'], at(0, 1.5)[0], places=9)
        self.assertAlmostEqual(G.nodes[start]['y'], at(0, 1.5)[1], places=9)

    def test_one_way_dead_end_falls_back_to_a_junction(self):
        G, start, stats = build(at(2, -1), [ONE_WAY])
        self.assertFalse(stats['start_snapped'])
        self.assertNotEqual(start, 9203)
        self.assertGreater(G.out_degree(start), 1)
        self.assertGreater(len(routes(G, start)), 0)


if __name__ == '__main__':
    unittest.main()
