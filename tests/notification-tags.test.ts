/**
 * Chính sách thẻ thông báo (`notificationTag`): hàm thuần, không cần DB hay biến môi trường.
 * Việc thẻ thật sự được gửi lên FCM và vào `data.tag` được kiểm ở các test gửi (jobs, overdue, devices...).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DAY_DIGEST_TAG,
  DIGEST_KINDS,
  NOTIFICATION_KINDS,
  OVERDUE_DIGEST_TAG,
  notificationTag,
  type NotificationJobKind,
} from "../src/config/notification-policy.js";

const UUID = "0192f3c0-aaaa-7bbb-8ccc-0123456789ab";

const TODO_KINDS: readonly NotificationJobKind[] = ["todo_reminder", "todo_overdue", "todo_timer_end"];
const CHECKLIST_KINDS: readonly NotificationJobKind[] = [
  "checklist_due",
  "checklist_running",
  "checklist_30m",
  "checklist_overdue",
];
const DAY_DIGESTS: readonly NotificationJobKind[] = [
  "digest_morning",
  "digest_todos",
  "digest_habits",
  "digest_review",
];
const OVERDUE_DIGESTS: readonly NotificationJobKind[] = ["digest_overdue_evening", "digest_overdue_morning"];

test("every notification kind gets a non-empty tag that is far below the 128-character limit", () => {
  for (const kind of NOTIFICATION_KINDS) {
    const tag = notificationTag(kind, UUID);
    assert.ok(tag.trim().length > 0, kind);
    assert.ok(tag.length <= 64, `${kind}: ${tag.length}`);
  }
});

test("the groups below cover every kind exactly once, so a new kind cannot silently skip this file", () => {
  const grouped = [...TODO_KINDS, ...CHECKLIST_KINDS, ...DAY_DIGESTS, ...OVERDUE_DIGESTS];
  assert.deepEqual([...grouped].sort(), [...NOTIFICATION_KINDS].sort());
  assert.deepEqual([...DAY_DIGESTS, ...OVERDUE_DIGESTS].sort(), [...DIGEST_KINDS].sort());
});

test("one todo keeps one card: on-time reminder, repeated nudges and countdown end replace each other", () => {
  assert.deepEqual([...new Set(TODO_KINDS.map((kind) => notificationTag(kind, "t1")))], ["todo:t1"]);
});

test("one checklist keeps one card: the due reminder and the 'still running' nudges share a tag", () => {
  // The caller passes the CHECKLIST (template) id for both, never the run id.
  assert.deepEqual([...new Set(CHECKLIST_KINDS.map((kind) => notificationTag(kind, "tpl-1")))], ["checklist:tpl-1"]);
  assert.equal(notificationTag("checklist_due", UUID), notificationTag("checklist_running", UUID));
});

test("different todos, different checklists and a todo versus a checklist never share a tag", () => {
  assert.notEqual(notificationTag("todo_overdue", "a"), notificationTag("todo_overdue", "b"));
  assert.notEqual(notificationTag("checklist_due", "a"), notificationTag("checklist_due", "b"));
  assert.notEqual(notificationTag("todo_reminder", "same"), notificationTag("checklist_due", "same"));
});

test("the daily summaries replace each other, whatever the date, so yesterday's never lingers", () => {
  const tags = new Set<string>();
  for (const kind of DAY_DIGESTS) {
    for (const date of ["2026-06-20", "2026-06-21"]) tags.add(notificationTag(kind, date));
  }
  assert.deepEqual([...tags], [DAY_DIGEST_TAG]);
});

test("the overdue summaries (17:00 and 07:00 next morning) are one slot of their own", () => {
  const tags = new Set<string>();
  for (const kind of OVERDUE_DIGESTS) {
    for (const date of ["2026-06-20", "2026-06-21"]) tags.add(notificationTag(kind, date));
  }
  assert.deepEqual([...tags], [OVERDUE_DIGEST_TAG]);
  assert.notEqual(OVERDUE_DIGEST_TAG, DAY_DIGEST_TAG, "an action item must not be wiped by the day summary");
});

test("summary tags cannot collide with a per-task tag, even for an id that looks like one", () => {
  for (const id of ["day", "overdue", "digest:day", "digest:overdue"]) {
    for (const kind of [...TODO_KINDS, ...CHECKLIST_KINDS]) {
      const tag = notificationTag(kind, id);
      assert.notEqual(tag, DAY_DIGEST_TAG);
      assert.notEqual(tag, OVERDUE_DIGEST_TAG);
    }
  }
});
