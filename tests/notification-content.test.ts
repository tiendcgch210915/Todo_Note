import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildChecklist30m,
  buildHabitsDigest,
  buildMorningDigest,
  buildTimerEnd,
  buildTodoReminder,
  buildTodosDigest,
} from "../src/services/notification-content.js";
import {
  CHEER_PHRASES,
  OFFSET_CHEER,
  OFFSET_PHILOSOPHY,
  PHILOSOPHY_PHRASES,
  STEP_CHEER,
  STEP_PHILOSOPHY,
  cheerForDate,
  philosophyForDate,
} from "../src/services/notification-phrases.js";

const stats = (totalTodos: number, doneTodos: number, habitsTotal: number, habitsDone = 0) => ({
  totalTodos,
  doneTodos,
  habitsTotal,
  habitsDone,
});

const DATE = "2026-06-20";
const firstLine = (body: string): string => body.split("\n")[0];

// ── digest_morning ───────────────────────────────────────────────────────────

test("morning digest, nothing done yet", () => {
  const m = buildMorningDigest(stats(5, 0, 3), DATE);
  assert.equal(m.title, "Chào buổi sáng");
  assert.equal(firstLine(m.body), "Hôm nay bạn có 5 todo cần hoàn thành & 3 thói quen cần duy trì.");
});

test("morning digest, partly done", () => {
  const m = buildMorningDigest(stats(5, 2, 3), DATE);
  assert.equal(
    firstLine(m.body),
    "Hôm nay bạn có 5 todo (đã xong 2, còn 3) & 3 thói quen cần duy trì."
  );
});

test("morning digest, everything done", () => {
  const m = buildMorningDigest(stats(4, 4, 2), DATE);
  assert.equal(firstLine(m.body), "Bạn đã hoàn thành cả 4 todo hôm nay! Còn 2 thói quen để duy trì.");
});

test("morning digest with no todos and no habits suggests adding a small goal", () => {
  const m = buildMorningDigest(stats(0, 0, 0), DATE);
  assert.match(firstLine(m.body), /thêm một mục tiêu nhỏ/);
});

test("morning digest ends with one cheer and one philosophy line, and stays short", () => {
  const m = buildMorningDigest(stats(3, 1, 1), DATE);
  const lines = m.body.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], cheerForDate(DATE));
  assert.equal(lines[2], philosophyForDate(DATE));
  assert.ok(m.body.length < 260, `body too long: ${m.body.length}`);
});

test("morning digest tolerates inconsistent counts instead of printing nonsense", () => {
  const m = buildMorningDigest(stats(2, 9, 1, 5), DATE);
  assert.equal(firstLine(m.body), "Bạn đã hoàn thành cả 2 todo hôm nay! Còn 1 thói quen để duy trì.");
});

// ── digest_todos ─────────────────────────────────────────────────────────────

test("todos digest is skipped when there are no todos", () => {
  assert.equal(buildTodosDigest(stats(0, 0, 4)), null);
});

test("todos digest: none done, some done, all done", () => {
  assert.equal(
    buildTodosDigest(stats(3, 0, 0))?.body,
    "Hôm nay chưa có todo nào hoàn thành, còn 3 todo đang chờ bạn. Hãy bắt đầu bằng việc nhỏ nhất!"
  );
  assert.equal(
    buildTodosDigest(stats(5, 2, 0))?.body,
    "Bạn đã hoàn thành 2 todo rồi, còn lại 3 todo nữa vẫn đang chờ bạn."
  );
  assert.equal(
    buildTodosDigest(stats(4, 4, 0))?.body,
    "Tuyệt vời! Bạn đã hoàn thành cả 4 todo hôm nay."
  );
});

// ── digest_habits ────────────────────────────────────────────────────────────

test("habits digest is skipped when no habit needs maintaining", () => {
  assert.equal(buildHabitsDigest(stats(5, 5, 0)), null);
});

test("habits digest: none, some, all maintained", () => {
  assert.equal(
    buildHabitsDigest(stats(0, 0, 3, 0))?.body,
    "Hôm nay bạn chưa duy trì thói quen nào, vẫn còn thời gian để làm một thói quen nhỏ trước khi hết ngày!"
  );
  assert.equal(buildHabitsDigest(stats(0, 0, 3, 1))?.body, "Hôm nay bạn đã duy trì được 1/3 thói quen.");
  assert.equal(buildHabitsDigest(stats(0, 0, 3, 3))?.body, "Tuyệt vời! Bạn đã duy trì đủ 3/3 thói quen hôm nay.");
});

// ── event notifications ──────────────────────────────────────────────────────

test("todo reminder uses the fixed title and the todo name as body", () => {
  assert.deepEqual(buildTodoReminder("Uống nước"), { title: "Đến giờ thực hiện", body: "Uống nước" });
});

test("timer end names the todo and the ORIGINAL estimate in minutes", () => {
  const m = buildTimerEnd("Viết báo cáo", 25 * 60);
  assert.equal(m.title, "Hết giờ đếm ngược");
  assert.equal(
    m.body,
    "“Viết báo cáo” đã đủ 25 phút. Hãy đánh dấu hoàn thành hoặc bắt đầu lại nếu cần nhé."
  );
  assert.match(buildTimerEnd("x", 20).body, /đã đủ 1 phút/); // never "0 phút"
  assert.doesNotMatch(buildTimerEnd("x", null).body, /phút/);
});

test("checklist reminder reports the steps still unticked, and is skipped when none", () => {
  assert.equal(
    buildChecklist30m("Rời nhà", 3)?.body,
    "Checklist “Rời nhà” đã chạy 30 phút. Còn 3 bước chưa tick, hãy kiểm tra lại cho đầy đủ nhé."
  );
  assert.equal(buildChecklist30m("Rời nhà", 0), null);
});

test("very long names are clipped so the push stays short", () => {
  const long = "a".repeat(500);
  assert.ok(buildTodoReminder(long).body.length <= 200);
  assert.ok(buildTimerEnd(long, 60).body.length < 200);
});

// ── phrase pools ─────────────────────────────────────────────────────────────

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

test("each pool has at least 30 unique, short phrases", () => {
  for (const pool of [CHEER_PHRASES, PHILOSOPHY_PHRASES]) {
    assert.ok(pool.length >= 30);
    assert.equal(new Set(pool).size, pool.length);
    for (const phrase of pool) {
      assert.ok(phrase.trim().length > 0 && phrase.length <= 90, phrase);
    }
  }
});

test("phrase selection is deterministic and never repeats on consecutive days", () => {
  assert.equal(gcd(STEP_CHEER, CHEER_PHRASES.length), 1);
  assert.equal(gcd(STEP_PHILOSOPHY, PHILOSOPHY_PHRASES.length), 1);
  assert.notEqual(OFFSET_CHEER, OFFSET_PHILOSOPHY);

  assert.equal(cheerForDate("2026-06-20"), cheerForDate("2026-06-20"));

  let day = Date.UTC(2026, 0, 1);
  let previousCheer = "";
  let previousPhilosophy = "";
  const seenCheers = new Set<string>();
  for (let i = 0; i < 800; i++, day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    const cheer = cheerForDate(date);
    const philosophy = philosophyForDate(date);
    assert.notEqual(cheer, previousCheer, `cheer repeated on ${date}`);
    assert.notEqual(philosophy, previousPhilosophy, `philosophy repeated on ${date}`);
    previousCheer = cheer;
    previousPhilosophy = philosophy;
    if (i < CHEER_PHRASES.length) seenCheers.add(cheer);
  }
  // within one full cycle every phrase is used exactly once
  assert.equal(seenCheers.size, CHEER_PHRASES.length);
});

test("the two pools are offset from each other, not locked to the same index", () => {
  const diffs = new Set<number>();
  for (let d = 1; d <= 20; d++) {
    const date = `2026-07-${String(d).padStart(2, "0")}`;
    diffs.add(
      CHEER_PHRASES.indexOf(cheerForDate(date)) -
        PHILOSOPHY_PHRASES.indexOf(philosophyForDate(date))
    );
  }
  assert.ok(diffs.size > 1);
});
