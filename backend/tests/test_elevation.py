"""SRTM elevation on a long-running server: a failed download pauses SRTM for
a while (node elevations stand in, not memoized), then it is tried again.

    cd backend
    python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import networkx as nx  # noqa: E402
import route_features as rf  # noqa: E402


class FakeSrtm:
    """get_elevation raises while `down`, else answers 100 m."""
    def __init__(self):
        self.down = False
        self.calls = 0

    def get_elevation(self, lat, lng):
        self.calls += 1
        if self.down:
            raise OSError('mirror unreachable')
        return 100.0


def one_edge_graph():
    G = nx.MultiDiGraph()
    G.add_node(1, x=-80.0, y=35.0, elevation=10.0)
    G.add_node(2, x=-80.0, y=35.002, elevation=30.0)  # about 220 m north
    G.add_edge(1, 2, length=222.0)
    return G


class ElevationRecovery(unittest.TestCase):
    def setUp(self):
        self.saved = (rf._srtm_data, rf._srtm_down_until, rf.SRTM_RETRY_S)
        self.fake = FakeSrtm()
        rf._srtm_data, rf._srtm_down_until = self.fake, 0.0

    def tearDown(self):
        rf._srtm_data, rf._srtm_down_until, rf.SRTM_RETRY_S = self.saved

    def test_failure_pauses_then_recovers(self):
        G = one_edge_graph()
        self.fake.down = True
        first = rf._edge_elevation_samples(G, 1, 2, 50)
        self.assertEqual(first[0][4], 10.0, 'node elevations stand in while SRTM is down')
        self.assertEqual(self.fake.calls, 1, 'one failure pauses SRTM (no retry per sample)')

        # Still paused: no new download attempts, and the stand-in was not memoized.
        again = rf._edge_elevation_samples(G, 1, 2, 50)
        self.assertEqual(self.fake.calls, 1)
        self.assertEqual([s[4] for s in again], [s[4] for s in first])

        # The pause ends and the mirror is back: real elevation, memoized from now on.
        self.fake.down = False
        rf._srtm_down_until = 0.0
        back = rf._edge_elevation_samples(G, 1, 2, 50)
        self.assertTrue(all(s[4] == 100.0 for s in back))
        calls = self.fake.calls
        rf._edge_elevation_samples(G, 1, 2, 50)
        self.assertEqual(self.fake.calls, calls, 'real samples are memoized')


if __name__ == '__main__':
    unittest.main()
