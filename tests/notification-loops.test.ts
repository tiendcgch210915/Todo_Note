import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import {
  LOOPS,
  normalizeFastLoopSeconds,
} from "../src/config/notification-policy.js";
import { createNotificationLoops } from "../src/services/notification-loops.js";
import { createShutdownHandler } from "../src/utils/graceful-shutdown.js";

afterEach(() => {
  mock.timers.reset();
});

const FAST_MS = 3000;

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const recordingLogger = () => {
  const records: Array<{ level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg: string }> = [];
  const make = (level: "info" | "warn" | "error") => (obj: object, msg: string) => {
    records.push({ level, obj: obj as Record<string, unknown>, msg });
  };
  return { records, logger: { info: make("info"), warn: make("warn"), error: make("error") } };
};

const noop = async (): Promise<void> => {};

// ── NOTIFY_FAST_LOOP_SECONDS ─────────────────────────────────────────────────

test("NOTIFY_FAST_LOOP_SECONDS: default 3, minimum 1, junk never crashes the server", () => {
  const cases: Array<[unknown, number]> = [
    [undefined, 3],
    [null, 3],
    ["", 3],
    ["   ", 3],
    ["abc", 3],
    ["NaN", 3],
    ["Infinity", 3],
    ["0", 1],
    ["-5", 1],
    ["0.4", 1],
    ["1", 1],
    ["2.5", 2.5],
    ["3", 3],
    [" 5 ", 5],
    ["10", 10],
    ["999999999", LOOPS.fastMaxSeconds],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeFastLoopSeconds(raw), expected, JSON.stringify(raw));
  }
  assert.equal(LOOPS.fastDefaultSeconds, 3);
  assert.equal(LOOPS.fastMinSeconds, 1);
  assert.equal(LOOPS.maintenanceSeconds, 60);
});

// ── no overlapping beats ─────────────────────────────────────────────────────

test("a beat that is still running makes the next beats skip instead of piling up", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const gate = deferred();
  let dispatchCalls = 0;
  const { logger } = recordingLogger();
  const loops = createNotificationLoops({
    dispatch: () => {
      dispatchCalls++;
      return gate.promise;
    },
    maintain: noop,
    fastSeconds: 3,
    logger,
  });

  loops.start(); // immediate catch-up beat
  assert.equal(dispatchCalls, 1);
  for (let i = 0; i < 5; i++) mock.timers.tick(FAST_MS);
  assert.equal(dispatchCalls, 1, "still running: five beats were skipped, none queued");
  assert.equal(loops.stats().fast.skipped, 5);

  gate.resolve();
  await loops.idle();
  mock.timers.tick(FAST_MS);
  assert.equal(dispatchCalls, 2, "the next beat after completion runs normally");
  assert.equal(loops.stats().fast.runs, 2);
  await loops.stop();
});

test("the two loops are independent: a slow maintenance run does not block the fast loop", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const gate = deferred();
  let fast = 0;
  let maintenance = 0;
  const loops = createNotificationLoops({
    dispatch: async () => {
      fast++;
    },
    maintain: () => {
      maintenance++;
      return gate.promise;
    },
    fastSeconds: 3,
    logger: recordingLogger().logger,
  });

  loops.start();
  for (let i = 0; i < 4; i++) {
    mock.timers.tick(FAST_MS);
    // idle() would also wait for the (deliberately blocked) maintenance run: just yield once.
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(maintenance, 1, "maintenance still running, not re-entered");
  assert.ok(fast >= 2, `the fast loop kept beating while maintenance ran (${fast})`);
  gate.resolve();
  await loops.stop();
});

// ── cadence ──────────────────────────────────────────────────────────────────

test("fast beat every 3 s and maintenance every 60 s", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let fast = 0;
  let maintenance = 0;
  const loops = createNotificationLoops({
    dispatch: async () => {
      fast++;
    },
    maintain: async () => {
      maintenance++;
    },
    fastSeconds: 3,
    logger: recordingLogger().logger,
  });

  loops.start();
  await loops.idle();
  assert.deepEqual([fast, maintenance], [1, 1], "both run once immediately (catch-up after boot)");

  for (let elapsed = 0; elapsed < 60_000; elapsed += FAST_MS) {
    mock.timers.tick(FAST_MS);
    await loops.idle();
  }
  assert.equal(fast, 1 + 20, "20 fast beats in 60 s");
  assert.equal(maintenance, 1 + 1, "one maintenance beat in 60 s");
  await loops.stop();
});

test("start() twice does not double the timers", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let calls = 0;
  const loops = createNotificationLoops({
    dispatch: async () => {
      calls++;
    },
    maintain: noop,
    fastSeconds: 3,
    logger: recordingLogger().logger,
  });
  loops.start();
  loops.start();
  await loops.idle();
  mock.timers.tick(FAST_MS);
  await loops.idle();
  assert.equal(calls, 2);
  await loops.stop();
});

// ── transient failures ───────────────────────────────────────────────────────

test("a failing beat is logged and the loop keeps going", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { records, logger } = recordingLogger();
  let calls = 0;
  const loops = createNotificationLoops({
    dispatch: async () => {
      calls++;
      if (calls === 1) throw new Error("simulated DB outage");
    },
    maintain: noop,
    fastSeconds: 3,
    logger,
  });

  loops.start();
  await loops.idle();
  assert.equal(calls, 1);
  assert.equal(records.filter((r) => r.level === "error").length, 1);
  assert.equal(records.find((r) => r.level === "error")?.obj.loop, "fast");

  mock.timers.tick(FAST_MS);
  await loops.idle();
  assert.equal(calls, 2, "retried on the next beat");
  assert.deepEqual(
    [loops.stats().fast.runs, loops.stats().fast.failures],
    [2, 1]
  );
  await loops.stop();
});

test("a synchronous throw inside a task is handled the same way", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { records, logger } = recordingLogger();
  let calls = 0;
  const loops = createNotificationLoops({
    dispatch: () => {
      calls++;
      throw new Error("boom before any await");
    },
    maintain: noop,
    fastSeconds: 3,
    logger,
  });
  loops.start();
  await loops.idle();
  mock.timers.tick(FAST_MS);
  await loops.idle();
  assert.equal(calls, 2);
  assert.equal(records.filter((r) => r.level === "error").length, 1);
  await loops.stop();
});

test("repeated failures log at most once per minute and report how many were folded in", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { records, logger } = recordingLogger();
  let now = 1_000_000;
  const loops = createNotificationLoops({
    dispatch: async () => {
      throw new Error("db down");
    },
    maintain: noop,
    fastSeconds: 3,
    logger,
    clock: () => now,
  });

  loops.start();
  await loops.idle();
  for (let i = 0; i < 9; i++) {
    mock.timers.tick(FAST_MS);
    now += FAST_MS; // 27 s in total
    await loops.idle();
  }
  assert.equal(records.filter((r) => r.level === "error").length, 1, "10 failures, 1 log line");

  now += 40_000; // past the one-minute window
  mock.timers.tick(FAST_MS);
  await loops.idle();
  const errors = records.filter((r) => r.level === "error");
  assert.equal(errors.length, 2);
  assert.equal(errors[1].obj.suppressed_since_last_log, 9);
  await loops.stop();
});

// ── clean stop ───────────────────────────────────────────────────────────────

test("stop() waits for the running beat, then no more beats happen", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const gate = deferred();
  let calls = 0;
  const loops = createNotificationLoops({
    dispatch: () => {
      calls++;
      return gate.promise;
    },
    maintain: noop,
    fastSeconds: 3,
    logger: recordingLogger().logger,
  });
  loops.start();

  let stopped = false;
  const stopping = loops.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false, "stop() is waiting for the in-flight send");

  gate.resolve();
  await stopping;
  assert.equal(stopped, true);

  mock.timers.tick(FAST_MS * 5);
  await loops.idle();
  assert.equal(calls, 1, "no beat after stop");
  loops.start();
  assert.equal(calls, 1, "a stopped loop cannot be restarted by accident");
});

test("stop() gives up after the timeout when a beat hangs, and says so", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { records, logger } = recordingLogger();
  const loops = createNotificationLoops({
    dispatch: () => new Promise<void>(() => undefined), // never settles
    maintain: noop,
    fastSeconds: 3,
    logger,
    stopTimeoutMs: 10_000,
  });
  loops.start();

  const stopping = loops.stop();
  mock.timers.tick(10_000);
  await stopping;
  assert.ok(records.some((r) => r.level === "warn" && /did not finish/.test(r.msg)));
});

// ── graceful shutdown handler (real signals cannot be tested on Windows) ─────

const shutdownHarness = (overrides: Partial<Parameters<typeof createShutdownHandler>[0]> = {}) => {
  const order: string[] = [];
  const exits: number[] = [];
  const handler = createShutdownHandler({
    stop: async () => {
      order.push("stop");
    },
    close: async () => {
      order.push("close");
    },
    exit: (code) => {
      order.push(`exit:${code}`);
      exits.push(code);
    },
    log: { info() {}, error() {} },
    hardTimeoutMs: 5_000,
    ...overrides,
  });
  return { handler, order, exits };
};

test("shutdown stops the loops first, then closes the server, then exits 0", async () => {
  const { handler, order } = shutdownHarness();
  await handler("SIGTERM");
  assert.deepEqual(order, ["stop", "close", "exit:0"]);
});

test("a second signal while shutting down is ignored", async () => {
  const { handler, order } = shutdownHarness();
  await Promise.all([handler("SIGTERM"), handler("SIGINT")]);
  assert.deepEqual(order, ["stop", "close", "exit:0"]);
});

test("an error during shutdown still closes and exits with code 1", async () => {
  const { handler, order } = shutdownHarness({
    stop: async () => {
      throw new Error("stop failed");
    },
  });
  await handler("SIGTERM");
  assert.deepEqual(order, ["exit:1"]);
});

test("a shutdown that hangs is forced out after the hard timeout", async () => {
  const { handler, exits } = shutdownHarness({
    close: () => new Promise<void>(() => undefined),
    hardTimeoutMs: 40,
  });
  void handler("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [1]);
});
