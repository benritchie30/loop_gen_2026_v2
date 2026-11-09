"""What a visitor's message may ask for (limits.py).

    cd backend
    python -m unittest discover -s tests -v
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import limits  # noqa: E402


class Numbers(unittest.TestCase):
    def test_number(self):
        self.assertEqual(limits.number("12.5", 1), 12.5)
        for bad in (None, "abc", [], {}, float("nan"), float("inf"), -math.inf):
            self.assertEqual(limits.number(bad, 7), 7, bad)
        self.assertEqual(limits.number(500, 1, 0, 200), 200)
        self.assertEqual(limits.number(-3, 1, 0, 200), 0)

    def test_count(self):
        self.assertEqual(limits.count(10**9, 10, limits.MAX_PATHS), limits.MAX_PATHS)
        self.assertEqual(limits.count(0, 10, 200), 1)
        self.assertEqual(limits.count("x", 10, 200), 10)
        self.assertEqual(limits.count(12.7, 10, 200), 12)

    def test_lat_lng(self):
        self.assertEqual(limits.lat_lng(35.2, -80.8), (35.2, -80.8))
        self.assertEqual(limits.lat_lng("35.2", "-80.8"), (35.2, -80.8))
        for lat, lng in ((None, 1), (91, 0), (0, 181), (float("nan"), 0), ("a", "b")):
            self.assertIsNone(limits.lat_lng(lat, lng))

    def test_ident(self):
        self.assertEqual(limits.ident("abc"), "abc")
        for bad in (None, "", 5, ["a"], "x" * 65):
            self.assertIsNone(limits.ident(bad))

    def test_road_weights(self):
        self.assertIsNone(limits.road_weights(None))
        self.assertIsNone(limits.road_weights({"primary": "x"}))
        self.assertEqual(limits.road_weights({"primary": -2, "trunk": 1e9, "secondary": 1}),
                         {"primary": 0.0, "trunk": 1000.0, "secondary": 1.0})
        many = {f"c{i}": 1 for i in range(500)}
        self.assertEqual(len(limits.road_weights(many)), limits.MAX_ROAD_CLASSES)


class Lists(unittest.TestCase):
    def test_selections_capped(self):
        sels = [{"id": i, "type": "exclude", "shape": "circle", "lat": 1, "lng": 2, "radiusM": 5}
                for i in range(limits.MAX_SELECTIONS + 50)]
        self.assertEqual(len(limits.selections(sels)), limits.MAX_SELECTIONS)
        self.assertEqual(limits.selections("nope"), [])
        self.assertEqual(limits.selections([1, "a", None]), [])

    def test_selection_edges_and_rings(self):
        edges = [[1, 2], ["3", "4"], ["a", 5], [1], None, [1, 2, 3]]
        (sel,) = limits.selections([{"id": "r1", "shape": "edges", "edges": edges}])
        self.assertEqual(sel["edges"], [[1, 2], [3, 4]])
        huge = [[i, i + 1] for i in range(limits.MAX_EDGES_TOTAL + 10)]
        out = limits.selections([{"id": 1, "shape": "edges", "edges": huge},
                                 {"id": 2, "shape": "edges", "edges": huge}])
        self.assertEqual(len(out[0]["edges"]), limits.MAX_EDGES_PER_SELECTION)
        self.assertLessEqual(len(out[0]["edges"]) + len(out[1]["edges"]), limits.MAX_EDGES_TOTAL)
        ring = [[35 + i * 1e-5, -80] for i in range(limits.MAX_RING_POINTS + 100)] + [["x", 1]]
        (free,) = limits.selections([{"id": "f", "shape": "freeform", "coordinates": ring}])
        self.assertEqual(len(free["coordinates"]), limits.MAX_RING_POINTS)
        (bad_id,) = limits.selections([{"id": "x" * 100, "shape": "box"}])
        self.assertIsNone(bad_id["id"])

    def test_centroids(self):
        self.assertEqual(limits.centroids([[1, 2], "x", [float("nan"), 1], [3, 4]]), [(1.0, 2.0), (3.0, 4.0)])
        self.assertEqual(len(limits.centroids([[1, 2]] * (limits.MAX_CENTROIDS + 5))), limits.MAX_CENTROIDS)
        self.assertEqual(limits.centroids(None), [])


class Settings(unittest.TestCase):
    def env(self, value):
        if value is None:
            os.environ.pop("LOOP_TEST_SETTING", None)
        else:
            os.environ["LOOP_TEST_SETTING"] = value

    def tearDown(self):
        self.env(None)

    def test_env_number(self):
        import io
        from contextlib import redirect_stdout
        cases = [(None, 8, ""), ("", 8, ""), ("2", 2, ""), (" 3 ", 3, ""), ("2.0", 2, ""),
                 # cmd: `set LOOP_X=2 python server.py` stores the whole rest of the line
                 ("2 python server.py", 8, "is not a number"), ("0", 8, "is not at least 1")]
        for raw, expected, warning in cases:
            self.env(raw)
            out = io.StringIO()
            with redirect_stdout(out):
                got = limits.env_number("LOOP_TEST_SETTING", 8, lo=1)
            self.assertEqual(got, expected, raw)
            if warning:
                self.assertIn("LOOP_TEST_SETTING", out.getvalue())
                self.assertIn(warning, out.getvalue())
            else:
                self.assertEqual(out.getvalue(), "", raw)
        self.env("1.5")
        self.assertEqual(limits.env_number("LOOP_TEST_SETTING", 30, float), 1.5)


class Rate(unittest.TestCase):
    def test_bucket(self):
        now = [0.0]
        bucket = limits.RateLimit(rate=10, burst=5, clock=lambda: now[0])
        self.assertEqual(sum(bucket.allow() for _ in range(8)), 5)  # the burst, then refused
        now[0] += 0.5  # 5 tokens back
        self.assertEqual(sum(bucket.allow() for _ in range(8)), 5)


if __name__ == '__main__':
    unittest.main()
