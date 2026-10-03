import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/platform/errors.js";
import { freshPlatform, onboardedTraveler, findEvents, countEvents } from "./helpers.js";

const DAY = 24 * 3600 * 1000;

function bookingInput(vaultId, authId, over = {}) {
  return {
    vault_id: vaultId,
    auth_id: authId,
    hotel_party_id: "hotel-lakeside",
    resource_id: "room-501",
    date: "2026-10-05",
    amount: 680,
    currency: "CNY",
    reservation_ref: "HTL-88",
    ...over,
  };
}

function prepared(p, party = "hotel-lakeside") {
  const ctx = onboardedTraveler(p, { partyId: party });
  p.reservations.addCapacity(party, "room-501", "2026-10-05", 2);
  return ctx;
}

test("酒店预订主链路：最小断言 → 占位 → 扣款 → 确认发码", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  const flow = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-1",
    input: bookingInput(vaultId, authId),
  });
  assert.equal(flow.status, "completed");
  assert.deepEqual(flow.steps.map((s) => s.status), [
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  const qr = findEvents(p.store, "VOUCHER_ISSUED")[0].payload.qr_code;
  assert.equal(p.reservations.verifyVoucher(qr).valid, true);
});

test("入口防重：同一 startKey 重复启动只产生一条编排链", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  const input = bookingInput(vaultId, authId);
  const f1 = p.orchestrator.start("hotel_booking", { sessionId, startKey: "same", input });
  const f2 = p.orchestrator.start("hotel_booking", { sessionId, startKey: "same", input });
  assert.equal(f1.id, f2.id);
  assert.equal(countEvents(p.store, "STEP_ENQUEUED"), 4);
});

test("支付被明确拒绝（不可重试）→ 立即反向补偿，占位释放且无二维码", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  p.network.rejectOnce("acquirer-globalpay", "外卡扣款", "*", {
    code: "CARD_DECLINED",
    message: "发卡行拒付",
  });
  const flow = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-2",
    input: bookingInput(vaultId, authId),
  });
  assert.equal(flow.status, "compensated");
  assert.equal(flow.failedStep, "charge_card");
  const reserveStep = flow.steps.find((s) => s.key === "reserve_room");
  assert.equal(reserveStep.status, "compensated");
  assert.equal(p.reservations.occupancy("hotel-lakeside", "room-501", "2026-10-05").held, 0);
  assert.equal(countEvents(p.store, "VOUCHER_ISSUED"), 0);
});

test("扣款超时一次 → 到点自动重试成功，只产生一笔支付", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  p.network.timeoutOnce("acquirer-globalpay", "外卡扣款", "*");
  const flow0 = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-3",
    input: bookingInput(vaultId, authId),
  });
  const flowId = flow0.id;
  let flow = p.orchestrator.getFlow(flowId);
  assert.equal(flow.status, "running");
  assert.equal(flow.steps.find((s) => s.key === "charge_card").status, "suspended");

  // 退避未到点：tick 不恢复。
  p.clock.advance(499);
  assert.deepEqual(p.orchestrator.tick(), []);
  assert.equal(p.orchestrator.getFlow(flowId).status, "running");

  p.clock.advance(2);
  p.orchestrator.tick();
  flow = p.orchestrator.getFlow(flowId);
  assert.equal(flow.status, "completed");
  assert.equal(countEvents(p.store, "PAYMENT_INITIATED"), 1);
  assert.equal(flow.steps.find((s) => s.key === "charge_card").attempts, 2);
});

test("扣款回执丢失但远端已受理 → 定时重试不会盲目重发，对账确认 committed 后补齐且不重复扣款", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  p.network.loseNextResponse("acquirer-globalpay", "外卡扣款", "*");
  const flow0 = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-4",
    input: bookingInput(vaultId, authId),
  });
  const flowId = flow0.id;
  const suspendedStep = p.orchestrator.getFlow(flowId).steps.find((s) => s.key === "charge_card");
  assert.equal(suspendedStep.status, "suspended");
  assert.equal(suspendedStep.awaitReconciliation, true);

  // 即使退避时间过去、多次 tick，也绝不自动重发（防止远端其实已受理时二次扣款）。
  for (let i = 0; i < 3; i++) {
    p.clock.advance(60_000);
    p.orchestrator.tick();
  }
  assert.equal(p.orchestrator.getFlow(flowId).status, "running");
  assert.equal(countEvents(p.store, "PAYMENT_INITIATED"), 1);
  assert.equal(countEvents(p.store, "PAYMENT_SUCCEEDED"), 0); // 回执丢失，本地尚不知成功

  // 运维对账：probe 显示 committed → 补齐成功状态，流程继续到确认发码。
  p.orchestrator.recover(flowId);
  const flow = p.orchestrator.getFlow(flowId);
  assert.equal(flow.status, "completed");
  assert.equal(countEvents(p.store, "PAYMENT_INITIATED"), 1);
  assert.equal(countEvents(p.store, "PAYMENT_SUCCEEDED"), 1);
  assert.equal(flow.steps.find((s) => s.key === "charge_card").status, "succeeded");
});

test("回执丢失且对账证明远端 absent → 恢复时重新执行（仍只成功一次）", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  // 注入一次普通超时（请求未送达，probe 返回 absent），验证 recover 可安全重发。
  p.network.timeoutOnce("acquirer-globalpay", "外卡扣款", "*");
  const flow0 = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-4b",
    input: bookingInput(vaultId, authId),
  });
  const flowId = flow0.id;
  p.orchestrator.recover(flowId); // 无副作用嫌疑的挂起：人工恢复即重试
  assert.equal(p.orchestrator.getFlow(flowId).status, "completed");
  assert.equal(countEvents(p.store, "PAYMENT_INITIATED"), 1);
});

test("持续超时耗尽该服务方重试次数 → 补偿全部已成功步骤", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  p.network.alwaysTimeout("acquirer-globalpay", "外卡扣款");
  const flow0 = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-5",
    input: bookingInput(vaultId, authId),
  });
  // 退避基数 500ms，最多 4 次：逐次推进时钟触发剩余尝试。
  for (let i = 0; i < 5; i++) {
    p.clock.advance(10_000);
    p.orchestrator.tick();
  }
  const flow = p.orchestrator.getFlow(flow0.id);
  assert.equal(flow.status, "compensated");
  assert.equal(flow.steps.find((s) => s.key === "charge_card").attempts, 4);
  assert.equal(countEvents(p.store, "PAYMENT_INITIATED"), 0); // 超时期间从未发起成功
  assert.equal(p.reservations.occupancy("hotel-lakeside", "room-501", "2026-10-05").held, 0);
  assert.equal(countEvents(p.store, "COMPENSATION_COMPLETED"), 1);
});

test("酒店换订先立新后破旧：新酒店确认失败时旧单与旧码完好，新占位释放、差价退回", () => {
  const p = freshPlatform();
  const { sessionId, authId } = prepared(p, "hotel-lakeside");
  p.reservations.addCapacity("hotel-riverside", "room-303", "2026-10-05", 1);

  // 先有一张已确认的湖畔订单。
  const old = p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", idempotencyKey: "old-req",
  });
  p.reservations.confirmCallback("hotel-lakeside", {
    callbackId: "old-cb", reservationId: old.id, accepted: true, reservationRef: "OLD",
  });
  const oldCode = p.reservations.get(old.id).voucher.code;

  // 新酒店“确认”环节明确失败。
  p.network.rejectOnce("hotel-riverside", "换订确认", "*", {
    code: "OVERBOOKED",
    message: "酒店超售",
  });
  const flow = p.orchestrator.start("hotel_change", {
    sessionId,
    startKey: "chg-1",
    input: {
      auth_id: authId,
      old_hotel_party_id: "hotel-lakeside",
      old_reservation_id: old.id,
      new_hotel_party_id: "hotel-riverside",
      new_resource_id: "room-303",
      new_reservation_ref: "NEW",
      date: "2026-10-05",
      diff_amount: 120,
      currency: "CNY",
    },
  });
  assert.equal(flow.status, "compensated");
  // 旧单取消是最后一步，根本没有执行——游客继续入住原酒店，旧码仍有效。
  assert.equal(p.reservations.verifyVoucher(oldCode).valid, true);
  assert.equal(p.reservations.get(old.id).status, "confirmed");
  // 新侧已回退：占位释放、差价退款（只退一次）。
  assert.equal(p.reservations.occupancy("hotel-riverside", "room-303", "2026-10-05").held, 0);
  assert.equal(countEvents(p.store, "PAYMENT_REFUNDED"), 1);
});

test("酒店换订成功路径：新单确认后才取消旧单，旧码作废新码生效", () => {
  const p = freshPlatform();
  const { sessionId, authId } = prepared(p, "hotel-lakeside");
  p.reservations.addCapacity("hotel-riverside", "room-303", "2026-10-05", 1);
  const old = p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", idempotencyKey: "old-req",
  });
  p.reservations.confirmCallback("hotel-lakeside", {
    callbackId: "old-cb", reservationId: old.id, accepted: true, reservationRef: "OLD",
  });
  const oldCode = p.reservations.get(old.id).voucher.code;

  const flow = p.orchestrator.start("hotel_change", {
    sessionId,
    startKey: "chg-2",
    input: {
      auth_id: authId,
      old_hotel_party_id: "hotel-lakeside",
      old_reservation_id: old.id,
      new_hotel_party_id: "hotel-riverside",
      new_resource_id: "room-303",
      new_reservation_ref: "NEW",
      date: "2026-10-05",
      diff_amount: 120,
      currency: "CNY",
    },
  });
  assert.equal(flow.status, "completed");
  const steps = flow.steps.map((s) => s.key);
  assert.deepEqual(steps, ["reserve_new", "charge_diff", "confirm_new", "cancel_old"]);
  assert.equal(p.reservations.verifyVoucher(oldCode).valid, false);
  const newVoucher = findEvents(p.store, "VOUCHER_ISSUED").at(-1).payload.qr_code;
  assert.equal(p.reservations.verifyVoucher(newVoucher).valid, true);
  assert.equal(p.reservations.verifyVoucher(newVoucher).party_id, "hotel-riverside");
});

test("旧单取消明确失败（新单已就绪）→ 反向撤销新单并退差价，整体回到旧单可用状态", () => {
  const p = freshPlatform();
  const { sessionId, authId } = prepared(p, "hotel-lakeside");
  p.reservations.addCapacity("hotel-riverside", "room-303", "2026-10-05", 1);
  const old = p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", idempotencyKey: "old-req",
  });
  p.reservations.confirmCallback("hotel-lakeside", {
    callbackId: "old-cb", reservationId: old.id, accepted: true, reservationRef: "OLD",
  });
  const oldCode = p.reservations.get(old.id).voucher.code;

  p.network.rejectOnce("hotel-lakeside", "旧单取消", "*", {
    code: "CANCEL_REJECTED",
    message: "酒店政策不允许线上取消",
  });
  const flow = p.orchestrator.start("hotel_change", {
    sessionId,
    startKey: "chg-3",
    input: {
      auth_id: authId,
      old_hotel_party_id: "hotel-lakeside",
      old_reservation_id: old.id,
      new_hotel_party_id: "hotel-riverside",
      new_resource_id: "room-303",
      new_reservation_ref: "NEW",
      date: "2026-10-05",
      diff_amount: 120,
      currency: "CNY",
    },
  });
  assert.equal(flow.status, "compensated");
  // 旧单仍可用；新单被反向取消、差价退回。
  assert.equal(p.reservations.verifyVoucher(oldCode).valid, true);
  assert.equal(p.reservations.occupancy("hotel-riverside", "room-303", "2026-10-05").held, 0);
  assert.equal(countEvents(p.store, "PAYMENT_REFUNDED"), 1);
});

test("重试参数取自被调服务方策略（酒店 3 次、铁路 4 次、收单 4 次）", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  p.network.alwaysTimeout("hotel-lakeside", "预订占位");
  p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-6",
    input: bookingInput(vaultId, authId),
  });
  for (let i = 0; i < 5; i++) {
    p.clock.advance(10_000);
    p.orchestrator.tick();
  }
  const retryEvent = findEvents(p.store, "STEP_RETRY_SCHEDULED")[0];
  assert.equal(retryEvent.payload.max_attempts, 3); // 酒店策略
});

test("外卡充值主链路成功，重复启动同 startKey 不重复入账", () => {
  const p = freshPlatform();
  const { sessionId } = prepared(p);
  const input = { amount: 500, currency: "CNY" };
  const f1 = p.orchestrator.start("wallet_topup", { sessionId, startKey: "topup-1", input });
  const f2 = p.orchestrator.start("wallet_topup", { sessionId, startKey: "topup-1", input });
  assert.equal(f1.id, f2.id);
  assert.equal(f1.status, "completed");
  assert.equal(countEvents(p.store, "PAYMENT_SUCCEEDED"), 1);
});

test("游客视图展示每步处理方、状态与失败后的继续方式", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = prepared(p);
  p.network.timeoutOnce("acquirer-globalpay", "外卡扣款", "*");
  const f0 = p.orchestrator.start("hotel_booking", {
    sessionId,
    startKey: "bk-7",
    input: bookingInput(vaultId, authId),
  });
  const view = p.orchestrator.travelerView(f0.id);
  const charge = view.steps.find((s) => s.label.includes("外卡支付"));
  assert.equal(charge.handled_by, "环球外卡收单");
  assert.equal(charge.state, "suspended");
  assert.match(charge.next_action, /自动重试/);
  assert.ok(!JSON.stringify(view).includes("passport"));
});
