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


class SampleSpacing(unittest.TestCase):
    """Samples sit where their distance says, also on an edge that turns
    (degrees of longitude are shorter than degrees of latitude)."""

    def test_samples_are_spaced_in_metres(self):
        from shapely.geometry import LineString
        lat0, lng0 = 35.0, -80.0
        north = 1000.0 / 111000.0                                   # ~1 km north...
        _, _, leg1 = rf._geod.inv(lng0, lat0, lng0, lat0 + north)
        east = 1000.0 / (111320.0 * 0.8192)                         # ...then ~1 km east
        corner = (lng0, lat0 + north)
        end = (lng0 + east, lat0 + north)
        G = nx.MultiDiGraph()
        G.add_node(1, x=lng0, y=lat0, elevation=0.0)
        G.add_node(2, x=end[0], y=end[1], elevation=0.0)
        G.add_edge(1, 2, length=2000.0, geometry=LineString([(lng0, lat0), corner, end]))
        samples = list(rf._sample_path_geometry(G, [1, 2], 50))
        # The sample nearest the corner's distance is on the corner.
        d, lat, lng, _b = min(samples, key=lambda smp: abs(smp[0] - leg1))
        _, _, off = rf._geod.inv(lng, lat, corner[0], corner[1])
        self.assertLess(off, abs(d - leg1) + 1.0)
        # Every sample is its distance along the road from the start.
        for d, lat, lng, _b in samples:
            if d <= leg1:
                _, _, along = rf._geod.inv(lng0, lat0, lng, lat)
            else:
                _, _, past = rf._geod.inv(corner[0], corner[1], lng, lat)
                along = leg1 + past
            self.assertAlmostEqual(along, d, delta=1.0)


class GridFile:
    """A stand-in SRTM tile: a (n+1) x (n+1) grid, rows running south from latitude + 1."""
    def __init__(self, rows, latitude=36.0, longitude=-82.0):
        self.rows, self.latitude, self.longitude = rows, latitude, longitude
        self.square_side = len(rows)

    def get_elevation_from_row_and_column(self, row, column):
        return self.rows[row][column]


class Bilinear(unittest.TestCase):
    def test_blends_the_four_grid_points_around(self):
        f = GridFile([[10, 20, 30], [40, 50, 60], [70, 80, 90]])  # 3 x 3: points every half degree
        self.assertEqual(rf._bilinear(f, 37.0, -82.0), 10)          # a grid point is itself
        self.assertEqual(rf._bilinear(f, 36.5, -81.5), 50)
        self.assertAlmostEqual(rf._bilinear(f, 36.75, -81.75), (10 + 20 + 40 + 50) / 4)
        self.assertAlmostEqual(rf._bilinear(f, 36.5, -81.25), 55)   # halfway along a row
        self.assertEqual(rf._bilinear(f, 36.0, -81.0), 90)          # the south-east corner

    def test_void_points_are_left_out(self):
        f = GridFile([[10, None, 30], [40, 50, 60], [70, 80, 90]])
        self.assertAlmostEqual(rf._bilinear(f, 36.75, -81.75), (10 + 40 + 50) / 3)
        self.assertIsNone(rf._bilinear(GridFile([[None] * 3] * 3), 36.5, -81.5))


class NoisySrtm:
    """Elevation rising 1 m per 100 m northwards, with +-2 m of sawtooth noise (roofs, trees)."""
    def get_elevation(self, lat, lng):
        north_m = (lat - 35.0) * 111000.0
        return 100.0 + north_m / 100.0 + (2.0 if int(north_m // 25) % 2 else -2.0)


class Profile(unittest.TestCase):
    def setUp(self):
        self.saved = (rf._srtm_data, rf._srtm_down_until)
        rf._srtm_data, rf._srtm_down_until = NoisySrtm(), 0.0

    def tearDown(self):
        rf._srtm_data, rf._srtm_down_until = self.saved

    def test_smoothing_keeps_the_ends_and_flattens_noise(self):
        dists = [i * 25.0 for i in range(41)]
        noisy = [100 + (3 if i % 2 else -3) for i in range(41)]
        out = rf._smooth_profile(dists, noisy)
        self.assertEqual((out[0], out[-1]), (noisy[0], noisy[-1]))
        self.assertLess(max(abs(e - 100) for e in out[5:-5]), 1.0)
        for e in rf._smooth_profile(dists, [7.0] * 41):
            self.assertAlmostEqual(e, 7.0)

    def test_samples_every_25_m_and_climb_from_the_smoothed_profile(self):
        G = nx.MultiDiGraph()
        G.add_node(1, x=-80.0, y=35.0, elevation=0.0)
        G.add_node(2, x=-80.0, y=35.018, elevation=0.0)  # 2 km north: 20 m of real rise
        G.add_edge(1, 2, length=2000.0)
        profile, climb_ft, _descent = rf.compute_elevation_profile(G, [1, 2])
        spacing_m = (profile[1][0] - profile[0][0]) * 1609.344
        self.assertAlmostEqual(spacing_m, 25.0, delta=0.5)
        raw = [NoisySrtm().get_elevation(p[2], p[3]) * rf.FEET_PER_METER for p in profile]
        raw_climb = sum(max(0.0, b - a) for a, b in zip(raw, raw[1:]))
        real_ft = 20.0 * rf.FEET_PER_METER
        self.assertGreater(raw_climb, 3 * real_ft)           # the noise triples it, unsmoothed
        self.assertLess(abs(climb_ft - real_ft), 0.25 * real_ft)  # smoothed: close to the real rise


if __name__ == '__main__':
    unittest.main()
