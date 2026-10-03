import assert from "node:assert/strict";
import test from "node:test";

import { freshPlatform, onboardedTraveler, findEvents } from "./helpers.js";

test("运维链路追踪可还原步骤/服务方/重试，且看不到护照原件", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = onboardedTraveler(p);
  p.reservations.addCapacity("hotel-lakeside", "room-501", "2026-10-05", 2);
  p.network.timeoutOnce("acquirer-globalpay", "外卡扣款", "*");
  const f0 = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "trace-1",
    input: {
      vault_id: vaultId,
      auth_id: authId,
      hotel_party_id: "hotel-lakeside",
      resource_id: "room-501",
      date: "2026-10-05",
      amount: 680,
      currency: "CNY",
      reservation_ref: "HTL-1",
    },
  });
  const trace = p.traceView.trace(f0.id);
  // 编排步骤与服务方可诊断。
  const charge = trace.steps.find((s) => s.step_key === "charge_card");
  assert.equal(charge.party_id, "acquirer-globalpay");
  assert.equal(charge.diagnosis.health, "degraded");
  assert.ok(charge.diagnosis.retries >= 1);

  // 全链路序列化中绝不出现护照号/出生日期原件值。
  const serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes("E12345678"));
  assert.ok(!serialized.includes("1990-05-01"));
  // vault 事件被折叠为字段名清单，资格结论中的非敏感项（国籍/签证有效性）保留。
  const vaultItem = trace.timeline.find((e) => e.aggregate_type === "identity_vault");
  assert.ok(vaultItem.payload._redacted === "identity_vault_payload");
  assert.equal(vaultItem.payload.qualification.visa_valid, true);
});

test("留存清理按服务方各自天数执行，法定留档与过敏原溯源素材豁免", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = onboardedTraveler(p);
  p.reservations.addCapacity("hotel-lakeside", "room-501", "2026-10-05", 2);

  // 一笔完成的酒店预订（含已登记法定留档，由编排终态节点写入）。
  p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "ret-1",
    input: {
      vault_id: vaultId,
      auth_id: authId,
      hotel_party_id: "hotel-lakeside",
      resource_id: "room-501",
      date: "2026-10-05",
      amount: 680,
      currency: "CNY",
      reservation_ref: "HTL-1",
    },
  });

  // 一份菜单翻译（原图来源/置信度属于过敏原安全溯源，长期保留）。
  p.orchestrator.start("menu_translation", {
    sessionId,
    startKey: "ret-tr",
    input: {
      image_bytes: new TextEncoder().encode("menu"),
      lines: [{ line_id: "l1", original: "花生拼盘", translated: "Peanut platter", confidence: 0.96 }],
    },
  });

  let holdings = p.retention.listHoldings(sessionId);
  const classes = Object.fromEntries(holdings.map((h) => [h.dataClass, h]));
  assert.ok(classes.reservation_guest_data);
  assert.ok(classes.menu_translation_provenance);
  assert.ok(classes.payment_record);
  // 酒店预订数据处于法定留档保护（住宿登记 + 收单方留档）。
  assert.ok(classes.reservation_guest_data.legal_protected_until);

  // 推进 100 天：铁路类 30 天数据会被清，酒店 90 天到期但有法定留档保护，菜单溯源不清。
  p.clock.advance(100 * 24 * 3600 * 1000);
  const purged = p.retention.sweep();
  const purgedClasses = purged.map((x) => x.data_class);
  assert.ok(!purgedClasses.includes("menu_translation_provenance"));
  assert.ok(!purgedClasses.includes("reservation_guest_data")); // 法定留档豁免
  assert.ok(!purgedClasses.includes("payment_record")); // 收单 180 天且法定留档

  const after = p.retention.listHoldings(sessionId);
  const menu = after.find((h) => h.dataClass === "menu_translation_provenance");
  assert.equal(menu.data_present, true);
  const hotel = after.find((h) => h.dataClass === "reservation_guest_data");
  assert.equal(hotel.data_present, true);

  // 清理动作本身被记录为 RETENTION_PURGED（如有可清项）。
  const purgedEvents = findEvents(p.store, "RETENTION_PURGED");
  assert.ok(Array.isArray(purgedEvents));
});

test("授权撤回后清理到期数据，法定留档保护仍保留已完成交易副本", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = onboardedTraveler(p);
  p.reservations.addCapacity("hotel-lakeside", "room-501", "2026-10-05", 2);
  p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "ret-2",
    input: {
      vault_id: vaultId,
      auth_id: authId,
      hotel_party_id: "hotel-lakeside",
      resource_id: "room-501",
      date: "2026-10-05",
      amount: 680,
      currency: "CNY",
      reservation_ref: "HTL-2",
    },
  });
  // 入住与扣款均已完成并进入法定留档后，游客撤回授权。
  p.authorization.revoke(authId);
  p.clock.advance(100 * 24 * 3600 * 1000); // 已超过酒店常规留存 90 天
  p.retention.sweep();
  const hotel = p.retention
    .listHoldings(sessionId)
    .find((h) => h.dataClass === "reservation_guest_data");
  assert.equal(hotel.data_present, true); // 撤回不破坏法定留档
  assert.ok(hotel.legal_protected_until);
});
