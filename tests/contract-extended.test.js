import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES, SERVICE_PROVIDERS } from "../src/contracts.js";
import { findIdentityLeaks, lintEvent, validateEvent } from "../src/validator.js";

test("既有样例仍然通过校验（向后兼容）", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
  assert.deepEqual(lintEvent(sample), []);
});

test("JS 枚举、JSON Schema、TS 契约三方一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...EVENT_TYPES].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...AGGREGATE_TYPES].sort(), [...schema.properties.aggregate_type.enum].sort());
  assert.deepEqual([...SERVICE_PROVIDERS].sort(), [...schema.properties.service_provider.enum].sort());
  // 原有五个事件与四个聚合必须保持在位（只追加不移除）。
  for (const t of ["IDENTITY_VERIFIED", "SERVICE_AUTHORIZED", "RESERVATION_CONFIRMED", "COMPENSATION_STARTED", "ITINERARY_UPDATED"]) {
    assert(EVENT_TYPES.includes(t));
  }
  for (const a of ["traveler_session", "service_authorization", "itinerary_revision", "orchestration_step"]) {
    assert(AGGREGATE_TYPES.includes(a));
  }
});

test("未知枚举值前向兼容：不报错，只告警", () => {
  const base = {
    event_id: "x",
    event_type: "FUTURE_EVENT",
    aggregate_type: "future_aggregate",
    aggregate_id: "a1",
    occurred_at: "2026-10-03T09:00:00Z",
    version: 1,
    summary: "未来版本消息",
    service_provider: "future_service",
  };
  assert.deepEqual(validateEvent(base), []);
  const warnings = lintEvent(base);
  assert.equal(warnings.length, 3);
});

test("护照原件字段出现在事件负载即判定为身份扩散", () => {
  const event = {
    event_id: "x",
    event_type: "IDENTITY_VERIFIED",
    aggregate_type: "traveler_session",
    aggregate_id: "a1",
    occurred_at: "2026-10-03T09:00:00Z",
    version: 1,
    summary: "违规事件",
    payload: { service: "hotel", guest: { passport_number: "E123", full_name: "SMITH" } },
  };
  const errors = validateEvent(event);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /身份扩散/);
  assert.equal(findIdentityLeaks({ sealed_ref: "seal_1" }).length, 0);
});
