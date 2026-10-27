import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildChecklistCarryover,
  buildChecklistRunning,
  buildChecklistDue,
  buildHabitsDigest,
  buildMorningDigest,
  buildTimerEnd,
  buildTodoReminder,
  buildTodosDigest,
  normalizePushTitle,
  todoPriorityBody,
} from "../src/services/notification-content.js";
import {
  DIGEST_LABELS,
  FALLBACK_TITLE,
  PUSH_TITLE_MAX_CHARS,
  QUOTE,
  TODO_REMINDER_BODY,
} from "../src/config/notification-labels.js";
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
const line = (body: string, index: number): string => body.split("\n")[index];
const { tasks, progress, habits, motivation, encouragement, reflection } = DIGEST_LABELS;

// ── digest_morning ───────────────────────────────────────────────────────────

test("morning digest layout: tasks line, blank line, motivation (quoted), reflection", () => {
  const m = buildMorningDigest(stats(5, 2, 3), DATE);
  assert.equal(m.title, "Chào buổi sáng");
  const lines = m.body.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(
    lines[0],
    "📋 Nhiệm vụ: Hôm nay bạn có 5 todo (đã xong 2, còn 3) & 3 thói quen cần duy trì."
  );
  assert.equal(lines[1], "", "exactly one blank line between the two blocks");
  assert.equal(lines[2], `💪 Động lực: “${cheerForDate(DATE)}”`);
  assert.equal(lines[3], `💡 Suy ngẫm: ${philosophyForDate(DATE)}`);
  assert.ok(lines[2].startsWith(motivation) && lines[3].startsWith(reflection));
});

test("morning digest: the quote uses curly quotes and the reflection is NOT quoted", () => {
  const body = buildMorningDigest(stats(1, 0, 0), DATE).body;
  assert.equal(QUOTE.open, "“");
  assert.equal(QUOTE.close, "”");
  assert.ok(line(body, 2).endsWith("”"));
  assert.doesNotMatch(line(body, 3), /[“”"]/);
});

test("morning digest keeps the numbers wording of every branch on the single tasks line", () => {
  const first = (s: ReturnType<typeof stats>) => line(buildMorningDigest(s, DATE).body, 0);
  assert.equal(first(stats(5, 0, 3)), `${tasks}Hôm nay bạn có 5 todo cần hoàn thành & 3 thói quen cần duy trì.`);
  assert.equal(
    first(stats(5, 2, 3)),
    `${tasks}Hôm nay bạn có 5 todo (đã xong 2, còn 3) & 3 thói quen cần duy trì.`
  );
  assert.equal(first(stats(4, 4, 2)), `${tasks}Bạn đã hoàn thành cả 4 todo hôm nay! Còn 2 thói quen để duy trì.`);
  assert.match(first(stats(0, 0, 0)), /^📋 Nhiệm vụ: Hôm nay chưa có todo hay thói quen nào\. Thử thêm một mục tiêu nhỏ/);
  // inconsistent counts are clamped instead of printing nonsense
  assert.equal(first(stats(2, 9, 1, 5)), `${tasks}Bạn đã hoàn thành cả 2 todo hôm nay! Còn 1 thói quen để duy trì.`);
});

test("digests contain no HTML or markdown and stay short", () => {
  for (const m of [
    buildMorningDigest(stats(5, 2, 3), DATE),
    buildTodosDigest(stats(3, 0, 0)),
    buildHabitsDigest(stats(0, 0, 3, 0)),
  ]) {
    assert.ok(m);
    assert.doesNotMatch(m.body, /[<>*_#`]|\*\*|\]\(/);
    assert.ok(m.body.length < 320, `body too long: ${m.body.length}`);
  }
});

// ── digest_todos ─────────────────────────────────────────────────────────────

test("todos digest is skipped when there are no todos", () => {
  assert.equal(buildTodosDigest(stats(0, 0, 4)), null);
});

test("todos digest: progress line first, encouragement on its own line only when there is one", () => {
  const none = buildTodosDigest(stats(3, 0, 0));
  assert.equal(none?.title, "Tổng kết todo hôm nay");
  assert.equal(
    none?.body,
    `${progress}Hôm nay chưa có todo nào hoàn thành, còn 3 todo đang chờ bạn.\n${encouragement}Hãy bắt đầu bằng việc nhỏ nhất!`
  );
  assert.equal(
    buildTodosDigest(stats(5, 2, 0))?.body,
    `${progress}Bạn đã hoàn thành 2 todo rồi, còn lại 3 todo nữa vẫn đang chờ bạn.`,
    "no encouragement line when the sentence has none"
  );
  assert.equal(
    buildTodosDigest(stats(4, 4, 0))?.body,
    `${progress}Bạn đã hoàn thành cả 4 todo hôm nay.\n${encouragement}Tuyệt vời!`
  );
});

// ── digest_habits ────────────────────────────────────────────────────────────

test("habits digest is skipped when no habit needs maintaining", () => {
  assert.equal(buildHabitsDigest(stats(5, 5, 0)), null);
});

test("habits digest: progress line first, encouragement on its own line only when there is one", () => {
  const none = buildHabitsDigest(stats(0, 0, 3, 0));
  assert.equal(none?.title, "Tổng kết thói quen");
  assert.equal(
    none?.body,
    `${habits}Hôm nay bạn chưa duy trì thói quen nào.\n${encouragement}Vẫn còn thời gian để làm một thói quen nhỏ trước khi hết ngày!`
  );
  assert.equal(buildHabitsDigest(stats(0, 0, 3, 1))?.body, `${habits}Hôm nay bạn đã duy trì được 1/3 thói quen.`);
  assert.equal(
    buildHabitsDigest(stats(0, 0, 3, 3))?.body,
    `${habits}Bạn đã duy trì đủ 3/3 thói quen hôm nay.\n${encouragement}Tuyệt vời!`
  );
});

test("labels and icons come from the single config file", () => {
  assert.deepEqual(DIGEST_LABELS, {
    tasks: "📋 Nhiệm vụ: ",
    progress: "📋 Tiến độ: ",
    habits: "📋 Thói quen: ",
    motivation: "💪 Động lực: ",
    encouragement: "💪 ",
    reflection: "💡 Suy ngẫm: ",
    today: "📋 Hôm nay: ",
    review: "🌙 ",
  });
});

// ── todo_reminder ────────────────────────────────────────────────────────────

test("todo reminder: title is the todo's own title, body follows importance and urgency", () => {
  const cases: Array<[number, number, string]> = [
    [1, 1, "Quan trọng, khẩn cấp → Làm ngay!"],
    [1, 0, "Quan trọng → Dành thời gian làm thật tốt."],
    [0, 1, "Khẩn cấp → Xử lý nhanh rồi chuyển việc."],
    [0, 0, "Việc nhẹ → Làm gọn rồi tiếp tục nhé."],
  ];
  for (const [important, urgent, body] of cases) {
    assert.deepEqual(buildTodoReminder("Uống nước", important, urgent), { title: "Uống nước", body });
  }
});

test("todo reminder: unclassified (either flag null/undefined) falls back to the generic text", () => {
  for (const [important, urgent] of [
    [null, null],
    [undefined, undefined],
    [1, null],
    [null, 1],
    [0, undefined],
  ] as const) {
    assert.equal(buildTodoReminder("X", important, urgent).body, "Đến giờ thực hiện", `${important}/${urgent}`);
  }
  assert.equal(TODO_REMINDER_BODY.unknown, "Đến giờ thực hiện");
});

test("todo reminder accepts booleans as well as 0/1", () => {
  assert.equal(todoPriorityBody(true, true), TODO_REMINDER_BODY.importantUrgent);
  assert.equal(todoPriorityBody(true, false), TODO_REMINDER_BODY.importantOnly);
  assert.equal(todoPriorityBody(false, true), TODO_REMINDER_BODY.urgentOnly);
  assert.equal(todoPriorityBody(false, false), TODO_REMINDER_BODY.neither);
});

// ── title normalization ──────────────────────────────────────────────────────

test("push titles: newlines and runs of spaces collapse, edges are trimmed", () => {
  assert.equal(normalizePushTitle("  Họp\n\n nhóm \t sáng  \r\n nay  ", "x"), "Họp nhóm sáng nay");
});

test("push titles are cut to at most 60 characters including the ellipsis", () => {
  const exact = "a".repeat(PUSH_TITLE_MAX_CHARS);
  assert.equal(normalizePushTitle(exact, "x"), exact, "60 characters are left alone");

  const cut = normalizePushTitle("a".repeat(61), "x");
  assert.equal(Array.from(cut).length, PUSH_TITLE_MAX_CHARS);
  assert.ok(cut.endsWith("…"));
  assert.equal(cut, `${"a".repeat(59)}…`);
});

test("cutting never splits an emoji or a Vietnamese letter", () => {
  const emoji = normalizePushTitle("😀".repeat(80), "x");
  assert.equal(Array.from(emoji).length, PUSH_TITLE_MAX_CHARS);
  assert.doesNotThrow(() => encodeURIComponent(emoji), "no lone surrogate");

  const decomposed = "ế".repeat(3); // ê + sắc written as combining marks
  assert.equal(normalizePushTitle(decomposed, "x"), "ếếế", "normalized to NFC before counting");
});

test("an empty or missing title falls back", () => {
  assert.equal(normalizePushTitle("", FALLBACK_TITLE.todo), "Todo");
  assert.equal(normalizePushTitle("  \n\t ", FALLBACK_TITLE.checklist), "Checklist");
  assert.equal(normalizePushTitle(null, "Checklist"), "Checklist");
  assert.equal(buildTodoReminder("   ", 1, 1).title, "Todo");
});

// ── checklist_due / checklist_running ───────────────────────────────────────────

test("checklist due: title is the checklist title, body shows the step count", () => {
  assert.deepEqual(buildChecklistDue("Rời nhà", 5), {
    title: "Rời nhà",
    body: "Đến giờ thực hiện · 5 bước",
  });
  assert.deepEqual(buildChecklistDue("Rời nhà", 1), { title: "Rời nhà", body: "Đến giờ thực hiện · 1 bước" });
});

test("checklist due without steps shows only the base text", () => {
  assert.equal(buildChecklistDue("Rời nhà", 0).body, "Đến giờ thực hiện");
  assert.equal(buildChecklistDue("Rời nhà", Number.NaN).body, "Đến giờ thực hiện");
});

test("checklist due: long and multi-line titles are normalized", () => {
  const m = buildChecklistDue(`Quy trình\nkiểm tra ${"rất dài ".repeat(20)}`, 3);
  assert.ok(Array.from(m.title).length <= PUSH_TITLE_MAX_CHARS);
  assert.doesNotMatch(m.title, /\n/);
  assert.ok(m.title.endsWith("…"));
  assert.ok(!m.title.endsWith(" …"), "no dangling space before the ellipsis");
  assert.equal(buildChecklistDue("", 2).title, "Checklist");
});

test("checklist running (hourly): short one-line body with hours so far and unticked steps", () => {
  assert.deepEqual(buildChecklistRunning("Rời nhà", 3, 2), {
    title: "Rời nhà",
    body: "⏳ Đã làm 2 giờ · còn 3 bước chưa tick",
  });
  assert.equal(buildChecklistRunning("Rời nhà", 1, 1)?.body, "⏳ Đã làm 1 giờ · còn 1 bước chưa tick");
  assert.equal(buildChecklistRunning("Rời nhà", 0, 2), null, "nothing left to tick: no push");
  assert.equal(buildChecklistRunning("Rời nhà", 3, 0)?.body, "⏳ Đã làm 1 giờ · còn 3 bước chưa tick", "hours are at least 1");
  assert.equal(Array.from(buildChecklistRunning("x".repeat(100), 1, 1)?.title ?? "").length, PUSH_TITLE_MAX_CHARS);
});

test("checklist running (next morning): says it was not finished yesterday", () => {
  assert.deepEqual(buildChecklistCarryover("Rời nhà", 3), {
    title: "Rời nhà",
    body: "🌅 Hôm qua chưa xong · còn 3 bước chưa tick",
  });
  assert.equal(buildChecklistCarryover("Rời nhà", 0), null);
  assert.equal(buildChecklistCarryover("", 2)?.title, "Checklist");
});

// ── timer end is unchanged ───────────────────────────────────────────────────

test("timer end names the todo and the ORIGINAL estimate in minutes (unchanged)", () => {
  const m = buildTimerEnd("Viết báo cáo", 25 * 60);
  assert.equal(m.title, "Hết giờ đếm ngược");
  assert.equal(
    m.body,
    "“Viết báo cáo” đã đủ 25 phút. Hãy đánh dấu hoàn thành hoặc bắt đầu lại nếu cần nhé."
  );
  assert.match(buildTimerEnd("x", 20).body, /đã đủ 1 phút/); // never "0 phút"
  assert.doesNotMatch(buildTimerEnd("x", null).body, /phút/);
  assert.ok(buildTimerEnd("a".repeat(500), 60).body.length < 200);
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
