import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/platform/errors.js";
import { freshPlatform, onboardedTraveler, findEvents } from "./helpers.js";

function initiate(p, sessionId, key = "pay-key-1") {
  return p.payments.initiate({
    sessionId,
    partyId: "acquirer-globalpay",
    purpose: "lodging_charge",
    amount: 680,
    currency: "CNY",
    idempotencyKey: key,
  });
}

test("重复发起（同幂等键）只产生一笔支付单", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const a = initiate(p, sessionId);
  const b = initiate(p, sessionId);
  assert.equal(a.id, b.id);
  assert.equal(findEvents(p.store, "PAYMENT_INITIATED").length, 1);
});

test("成功回调重复到达只生效一次", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const pay = initiate(p, sessionId);
  const cb = { callbackId: "cb-1", paymentId: pay.id, outcome: "succeeded", gatewayRef: "GW-1" };
  p.payments.resultCallback("acquirer-globalpay", cb);
  p.payments.resultCallback("acquirer-globalpay", cb);
  assert.equal(findEvents(p.store, "PAYMENT_SUCCEEDED").length, 1);
  assert.equal(p.payments.get(pay.id).status, "succeeded");
});

test("先成功后失败的冲突回调被拒绝，钱的状态以首个终态为准", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const pay = initiate(p, sessionId);
  p.payments.resultCallback("acquirer-globalpay", {
    callbackId: "cb-ok", paymentId: pay.id, outcome: "succeeded", gatewayRef: "GW-1",
  });
  assert.throws(
    () =>
      p.payments.resultCallback("acquirer-globalpay", {
        callbackId: "cb-fail", paymentId: pay.id, outcome: "failed", reason: "疑似重复扣款",
      }),
    (e) => e instanceof DomainError && e.code === "PAYMENT_TERMINAL_CONFLICT",
  );
  assert.equal(p.payments.get(pay.id).status, "succeeded");
});

test("补偿退款幂等：重复触发不会退两次", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const pay = initiate(p, sessionId);
  p.payments.resultCallback("acquirer-globalpay", {
    callbackId: "cb-ok", paymentId: pay.id, outcome: "succeeded", gatewayRef: "GW-1",
  });
  const r1 = p.payments.refund(pay.id, "refund-1", "编排补偿");
  // 同一退款键重放：返回首次结果而不是再退一次。
  const r2 = p.payments.refund(pay.id, "refund-1", "编排补偿");
  assert.equal(r2.id, r1.id);
  assert.equal(p.payments.get(pay.id).status, "refunded");
  // 换一个退款键也不能对已退款单再退。
  assert.throws(
    () => p.payments.refund(pay.id, "refund-2"),
    (e) => e.code === "ALREADY_REFUNDED",
  );
  assert.equal(findEvents(p.store, "PAYMENT_REFUNDED").length, 1);
});

test("未成功的支付不能退款", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const pay = initiate(p, sessionId);
  assert.throws(
    () => p.payments.refund(pay.id, "r1"),
    (e) => e.code === "REFUND_NOT_POSSIBLE",
  );
});
