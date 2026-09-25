import assert from "node:assert/strict";

async function waitForCondition(predicate, maxAttempts = 40) {
  for (let attempt = 0; attempt < maxAttempts && !predicate(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(predicate(), true);
}

function fakeTimers(startTime = 0) {
  let now = startTime;
  let nextTimerId = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(milliseconds) {
      now += milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= now)
          .sort(([, left], [, right]) => left.due - right.due)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        timer.callback();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    now: () => now,
    setNow(value) {
      now = value;
    },
  };
}

export { waitForCondition, fakeTimers };
