"""Visitors' searches and builds take turns (work_queue.WorkQueue).

    cd backend
    python -m unittest discover -s tests -v
"""
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from work_queue import WorkQueue  # noqa: E402


def wait_until(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


class Turns(unittest.TestCase):
    def test_free_slot_no_waiting_message(self):
        q = WorkQueue(1)
        seen = []
        self.assertTrue(q.acquire(on_wait=seen.append))
        self.assertEqual(seen, [])
        q.release()
        self.assertEqual(q.stats(), {"running": 0, "waiting": 0})

    def test_first_come_first_served_with_counts(self):
        q = WorkQueue(1)
        self.assertTrue(q.acquire())  # someone is searching
        order, ahead = [], {}

        def visitor(name):
            ahead[name] = []
            q.acquire(on_wait=ahead[name].append, poll=0.01)
            order.append(name)
            time.sleep(0.05)
            q.release()

        threads = []
        for name in ("a", "b", "c"):
            t = threading.Thread(target=visitor, args=(name,))
            t.start()
            threads.append(t)
            self.assertTrue(wait_until(lambda: q.stats()["waiting"] == len(threads)))
        self.assertEqual(ahead["c"][0], 3, "the running search and a, b are ahead of c")
        q.release()
        for t in threads:
            t.join(5)
        self.assertEqual(order, ["a", "b", "c"])
        self.assertEqual(ahead["a"], [1])
        self.assertEqual(ahead["c"], [3, 2, 1], "c hears each time the line moves")
        self.assertEqual(q.stats(), {"running": 0, "waiting": 0})

    def test_stop_leaves_the_line(self):
        q = WorkQueue(1)
        q.acquire()
        stop = threading.Event()
        result = {}
        t = threading.Thread(target=lambda: result.update(got=q.acquire(should_stop=stop.is_set, poll=0.01)))
        t.start()
        self.assertTrue(wait_until(lambda: q.stats()["waiting"] == 1))
        stop.set()
        t.join(5)
        self.assertFalse(result["got"])
        self.assertEqual(q.stats(), {"running": 1, "waiting": 0})
        # The one behind a stopped visitor is not held up by it.
        q.release()
        self.assertTrue(q.acquire())
        q.release()

    def test_earlier_request_goes_first(self):
        """A visitor's search (its request came first) goes before the map build of a
        visitor who came later, even though the build joined the line earlier."""
        q = WorkQueue(1)
        q.acquire()  # visitor A's map build is running
        order = []

        def step(name, priority):
            q.acquire(priority=priority, poll=0.01)
            order.append(name)
            q.release()

        b = threading.Thread(target=step, args=("B build", 2.0))
        b.start()
        self.assertTrue(wait_until(lambda: q.stats()["waiting"] == 1))
        a = threading.Thread(target=step, args=("A search", 1.0))
        a.start()
        self.assertTrue(wait_until(lambda: q.stats()["waiting"] == 2))
        q.release()  # A's build done
        a.join(5)
        b.join(5)
        self.assertEqual(order, ["A search", "B build"])

    def test_two_slots(self):
        q = WorkQueue(2)
        self.assertTrue(q.acquire())
        self.assertTrue(q.acquire())
        got = threading.Event()
        t = threading.Thread(target=lambda: (q.acquire(poll=0.01), got.set()))
        t.start()
        self.assertFalse(got.wait(0.1))
        q.release()
        self.assertTrue(got.wait(5))
        t.join(5)


if __name__ == '__main__':
    unittest.main()
