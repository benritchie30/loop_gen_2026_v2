"""One line for the CPU-heavy work of every visitor: route searches and area builds.

Python runs the search on one core at a time anyway, so two searches side by
side only make both slow (three at once: 24 s to a first route instead of 1).
Taking turns gives the first visitor full speed and tells the others how many
are ahead of them. Map downloads do not take a turn (they only wait on the
network).

The line is ordered by when each visitor's request arrived (`priority`), not
when each step joined it: a visitor's search, right after its own map build,
goes before the builds of visitors who came later, so each one is served start
to finish in turn.

Blocking, thread-safe: call acquire() from a worker thread (the server's
asyncio code does so through run_in_executor). A waiter leaves the line when
its should_stop() turns true (Stop, a new search, the tab closed).
"""
import itertools
import threading
import time
from typing import Callable, Optional


class WorkQueue:
    def __init__(self, slots: int = 1):
        self.slots = max(1, int(slots))
        self._cond = threading.Condition()
        self._running = 0
        self._waiting: list = []  # (priority, seq) tickets, kept sorted: the first is next
        self._seq = itertools.count()

    def acquire(self, should_stop: Optional[Callable[[], bool]] = None,
                on_wait: Optional[Callable[[int], None]] = None, poll: float = 0.2,
                priority: Optional[float] = None) -> bool:
        """Wait for a turn. priority: when the visitor's request arrived
        (time.monotonic(); default now); earlier goes first, ties in joining
        order. on_wait(ahead) is called (from this thread) when the caller has
        to wait and whenever the number ahead of it changes; not at all when a
        slot is free at once. Returns False if should_stop fired first (the
        caller then has no turn and must not release)."""
        ticket = (time.monotonic() if priority is None else priority, next(self._seq))
        last_ahead = None
        with self._cond:
            self._waiting.append(ticket)
            self._waiting.sort()
            try:
                while True:
                    if self._running < self.slots and self._waiting[0] == ticket:
                        self._waiting.pop(0)
                        self._running += 1
                        self._cond.notify_all()  # the next in line may fit too (slots > 1)
                        return True
                    if should_stop is not None and should_stop():
                        self._waiting.remove(ticket)
                        self._cond.notify_all()
                        return False
                    ahead = self._running + self._waiting.index(ticket)
                    if on_wait is not None and ahead != last_ahead:
                        last_ahead = ahead
                        self._cond.release()  # never call out while holding the lock
                        try:
                            on_wait(ahead)
                        finally:
                            self._cond.acquire()
                        continue  # things may have moved meanwhile
                    self._cond.wait(timeout=poll)
            except BaseException:
                if ticket in self._waiting:
                    self._waiting.remove(ticket)
                    self._cond.notify_all()
                raise

    def release(self) -> None:
        with self._cond:
            self._running = max(0, self._running - 1)
            self._cond.notify_all()

    def stats(self) -> dict:
        with self._cond:
            return {"running": self._running, "waiting": len(self._waiting)}
