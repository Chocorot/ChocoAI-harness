"""Run queue: the local model serves one stream at a time, so runs go through here one by one. Waiters are ordered by
priority (lower first) then arrival. The line is bounded: past `limit` a new request is refused with `busy`."""
import contextlib
import itertools
import threading

from errors import HarnessError


class RunQueue:
    def __init__(self, limit=lambda: 8):
        self._limit = limit  # callable so a saved setting applies without a restart
        self._cv = threading.Condition()
        self._waiting, self._running, self._seq = [], False, itertools.count()

    def busy(self):
        return self._running

    def _ready(self, ticket):
        return not self._running and min(self._waiting) == ticket

    @contextlib.contextmanager
    def slot(self, prio=1, on_wait=None, tick=10):
        """Wait for the model. `on_wait(runs_ahead)` is called at once and then every `tick` seconds while waiting;
        it may raise to leave the line."""
        ticket = (prio, next(self._seq))
        with self._cv:
            if (self._running or self._waiting) and len(self._waiting) >= self._limit():  # an idle queue never refuses
                raise HarnessError("busy")
            self._waiting.append(ticket)
        try:
            while True:
                with self._cv:
                    if self._ready(ticket):
                        self._running = True
                        break
                    ahead = sum(t < ticket for t in self._waiting) + self._running
                if on_wait:
                    on_wait(ahead)
                with self._cv:
                    if not self._ready(ticket):
                        self._cv.wait(tick)
        finally:
            with self._cv:
                self._waiting.remove(ticket)
                self._cv.notify_all()
        try:
            yield
        finally:
            with self._cv:
                self._running = False
                self._cv.notify_all()
