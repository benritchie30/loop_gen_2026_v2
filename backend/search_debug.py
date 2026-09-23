"""Server-side PNG snapshots of loop-search progress for debugging.

Uses Pillow only (matplotlib Agg segfaults on some Windows + QtAgg envs).
"""

from __future__ import annotations

import json
import math
import os
import time
from collections import Counter
from datetime import datetime
from typing import Any, Dict, List, Set, Tuple

import networkx as nx
from PIL import Image, ImageDraw


def _lerp_color(t: float, c0: Tuple[int, int, int], c1: Tuple[int, int, int]) -> Tuple[int, int, int]:
    t = max(0.0, min(1.0, t))
    return tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))


class SearchDebugger:
    """Tracks visit counts and writes periodic PNGs under backend/search_debug/."""

    def __init__(
        self,
        G: nx.MultiDiGraph,
        start_node: int,
        algorithm: str,
        graph_name: str = "graph",
        snapshot_every: int = 25000,
        size: int = 1000,
    ):
        self.G = G
        self.start_node = start_node
        self.algorithm = algorithm
        self.snapshot_every = max(1, int(snapshot_every))
        self.size = size
        self.pop_count: Counter = Counter()
        self.frontier: Set[int] = set()
        self.yielded_paths: List[List[int]] = []
        self.stats: List[Dict[str, Any]] = []
        self._snap_idx = 0
        self._t0 = time.time()
        self._node_xy: Dict[int, Tuple[float, float]] = {}
        self._edges: List[Tuple[int, int]] = []
        self._base: Image.Image | None = None
        self._enabled = True

        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_graph = "".join(c if c.isalnum() or c in "-_" else "_" for c in graph_name)
        safe_algo = "".join(c if c.isalnum() or c in "-_" else "_" for c in algorithm)
        base = os.path.join(os.path.dirname(__file__), "search_debug")
        self.out_dir = os.path.join(base, f"{safe_graph}_{safe_algo}_{stamp}")
        os.makedirs(self.out_dir, exist_ok=True)
        print(f"[search_debug] Writing snapshots to {self.out_dir}")

        for n, data in G.nodes(data=True):
            if "x" in data and "y" in data:
                self._node_xy[n] = (float(data["x"]), float(data["y"]))
        self._edges = [(u, v) for u, v in G.edges() if u in self._node_xy and v in self._node_xy]
        self._build_projector()
        self._build_base_image()

    def _build_projector(self):
        if not self._node_xy:
            self._project = lambda xy: (0, 0)
            return
        xs = [xy[0] for xy in self._node_xy.values()]
        ys = [xy[1] for xy in self._node_xy.values()]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        span_x = (max_x - min_x) or 1e-6
        span_y = (max_y - min_y) or 1e-6
        pad = 20
        usable = self.size - 2 * pad

        def project(xy: Tuple[float, float]) -> Tuple[int, int]:
            # Image y grows downward; lat/y grows upward
            px = pad + int((xy[0] - min_x) / span_x * usable)
            py = pad + int((max_y - xy[1]) / span_y * usable)
            return px, py

        self._project = project

    def _build_base_image(self):
        try:
            img = Image.new("RGB", (self.size, self.size), (255, 255, 255))
            draw = ImageDraw.Draw(img)
            for u, v in self._edges:
                draw.line([self._project(self._node_xy[u]), self._project(self._node_xy[v])],
                          fill=(180, 180, 180), width=1)
            for xy in self._node_xy.values():
                x, y = self._project(xy)
                draw.ellipse([x - 1, y - 1, x + 1, y + 1], fill=(200, 200, 200))
            self._base = img
        except Exception as e:
            print(f"[search_debug] base image failed ({e}); snapshots disabled")
            self._base = None
            self._enabled = False

    def record_pop(self, node_id: int):
        self.pop_count[node_id] += 1
        self.frontier.add(node_id)

    def record_yield(self, path: List[int]):
        self.yielded_paths.append(list(path))

    def maybe_snapshot(
        self,
        iters: int,
        queue_len: int,
        max_dist: float,
        yielded: int,
        force: bool = False,
    ):
        if not self._enabled or self._base is None:
            return
        if not force and (iters == 0 or iters % self.snapshot_every != 0):
            return
        self._write_snapshot(iters, queue_len, max_dist, yielded)

    def _write_snapshot(self, iters: int, queue_len: int, max_dist: float, yielded: int):
        img = self._base.copy()
        draw = ImageDraw.Draw(img)

        # Visit heat (yellow -> red by log count)
        max_c = max(self.pop_count.values()) if self.pop_count else 1
        for n, c in self.pop_count.items():
            xy = self._node_xy.get(n)
            if not xy:
                continue
            x, y = self._project(xy)
            t = math.log1p(c) / math.log1p(max_c)
            color = _lerp_color(t, (255, 230, 150), (200, 40, 40))
            r = 2 + int(4 * t)
            draw.ellipse([x - r, y - r, x + r, y + r], fill=color)

        # Frontier
        for n in self.frontier:
            xy = self._node_xy.get(n)
            if not xy:
                continue
            x, y = self._project(xy)
            draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(41, 128, 185))

        # Yielded loops
        for path in self.yielded_paths[-20:]:
            pts = [self._project(self._node_xy[n]) for n in path if n in self._node_xy]
            if len(pts) >= 2:
                draw.line(pts, fill=(142, 68, 173), width=2)

        # Start
        start_xy = self._node_xy.get(self.start_node)
        if start_xy:
            x, y = self._project(start_xy)
            draw.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(39, 174, 96), outline=(0, 0, 0))

        title = (
            f"{self.algorithm}  iters={iters}  queue={queue_len}  "
            f"max_dist={max_dist:.0f}m  yielded={yielded}  unique={len(self.pop_count)}"
        )
        draw.rectangle([0, 0, self.size, 18], fill=(255, 255, 255))
        draw.text((6, 2), title, fill=(20, 20, 20))

        self._snap_idx += 1
        fname = f"{self._snap_idx:03d}_iter{iters}.png"
        filepath = os.path.join(self.out_dir, fname)
        try:
            img.save(filepath)
        except Exception as e:
            print(f"[search_debug] save failed ({e})")

        row = {
            "snapshot": self._snap_idx,
            "iters": iters,
            "unique_nodes": len(self.pop_count),
            "max_dist_m": round(max_dist, 1),
            "queue": queue_len,
            "yielded": yielded,
            "elapsed_s": round(time.time() - self._t0, 2),
            "file": fname,
        }
        self.stats.append(row)
        self._flush_stats()
        self.frontier.clear()
        print(f"[search_debug] {filepath}")

    def _flush_stats(self):
        path = os.path.join(self.out_dir, "stats.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.stats, f, indent=2)

    def finish(self, iters: int, queue_len: int, max_dist: float, yielded: int):
        self.maybe_snapshot(iters, queue_len, max_dist, yielded, force=True)
        self._base = None
        print(f"[search_debug] Done. {len(self.stats)} snapshots in {self.out_dir}")
