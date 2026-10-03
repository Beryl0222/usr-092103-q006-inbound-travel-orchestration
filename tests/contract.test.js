import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { AggregateType, EventType } from "../src/domain.ts";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("合法信封（含 payload/correlation/causation）通过", () => {
  const errors = validateEvent({
    event_id: "e1",
    event_type: "STEP_SUSPENDED",
    aggregate_type: "orchestration_step",
    aggregate_id: "s1",
    occurred_at: "2026-10-03T09:00:00Z",
    version: 1,
    summary: "挂起",
    payload: { not_before: "2026-10-03T09:00:01Z" },
    correlation_id: "flow-1",
    causation_id: "evt-0",
  });
  assert.deepEqual(errors, []);
});

test("schema 枚举与 domain.ts 常量保持一致（防止契约漂移）", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...new Set(Object.values(EventType))].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...new Set(Object.values(AggregateType))].sort(), [...schema.properties.aggregate_type.enum].sort());
});

test("未知事件类型/聚合类型/畸形字段被拒绝", () => {
  assert.ok(validateEvent({ event_type: "NOPE" }).some((e) => e.includes("未知事件类型")));
  const bad = validateEvent({
    event_id: "",
    event_type: "IDENTITY_VERIFIED",
    aggregate_type: "bogus",
    aggregate_id: "x",
    occurred_at: "not-a-date",
    version: 0,
    summary: "",
  });
  assert.ok(bad.some((e) => e.includes("未知聚合类型")));
  assert.ok(bad.some((e) => e.includes("version")));
  assert.ok(bad.some((e) => e.includes("occurred_at")));
});
