import assert from "node:assert/strict";
import test from "node:test";

import { bootPlatform } from "./helpers.js";
import { RetryableError } from "../src/runtime/orchestration.js";
import { policyOf } from "../src/runtime/policies.js";

const CORR = "corr-pay";

test("支付发起幂等：同一业务键重放，不产生第二笔", () => {
  const { platform, session } = bootPlatform();
  const args = {
    sessionId: session.session_id,
    service: "hotel:pearl",
    clientPaymentId: "ORDER-1001",
    amount: 1200,
    correlationId: CORR,
  };
  const a = platform.payments.initiate(args);
  const b = platform.payments.initiate(args);
  assert.equal(b.replayed, true);
  assert.equal(a.payment.payment_id, b.payment.payment_id);
});

test("重复回调去重：重投成功回调不二次扣款，落 CALLBACK_DEDUPED", () => {
  const { platform, session } = bootPlatform();
  const { payment } = platform.payments.initiate({
    sessionId: session.session_id,
    service: "hotel:pearl",
    clientPaymentId: "ORDER-1002",
    amount: 680,
    correlationId: CORR,
  });
  const cb = { paymentId: payment.payment_id, callbackId: "N-001", outcome: "captured", correlationId: CORR };
  const first = platform.payments.handleCallback(cb);
  assert.equal(first.deduped, false);
  const second = platform.payments.handleCallback(cb);
  const third = platform.payments.handleCallback(cb);
  assert.equal(second.deduped, true);
  assert.equal(third.deduped, true);
  assert.equal(platform.payments.get(payment.payment_id).status, "captured");
  const dedupEvents = platform.events().filter((e) => e.event_type === "CALLBACK_DEDUPED");
  assert.equal(dedupEvents.length, 2);
});

test("已扣款后不同流水号的成功通知仍不去二次入账；失败通知触发冲突挂起", () => {
  const { platform, session } = bootPlatform();
  const { payment } = platform.payments.initiate({
    sessionId: session.session_id,
    service: "merchant:shop",
    clientPaymentId: "ORDER-1003",
    amount: 99,
    correlationId: CORR,
  });
  platform.payments.handleCallback({ paymentId: payment.payment_id, callbackId: "N-1", outcome: "captured", correlationId: CORR });
  const late = platform.payments.handleCallback({ paymentId: payment.payment_id, callbackId: "N-2", outcome: "captured", correlationId: CORR });
  assert.equal(late.deduped, true);
  assert.equal(platform.payments.get(payment.payment_id).status, "captured");

  assert.throws(
    () =>
      platform.payments.handleCallback({
        paymentId: payment.payment_id,
        callbackId: "N-3",
        outcome: "failed",
        correlationId: CORR,
        reason: "银行拒付",
      }),
    (err) => err.code === "PAYMENT_CONFLICT",
  );
});

test("外卡充值走同一状态机：成功回调只入账一次", () => {
  const { platform, session } = bootPlatform();
  const { payment } = platform.payments.initiate({
    sessionId: session.session_id,
    service: "wallet:topup",
    clientPaymentId: "TOPUP-77",
    amount: 500,
    topUp: true,
    correlationId: CORR,
  });
  platform.payments.handleCallback({ paymentId: payment.payment_id, callbackId: "T-1", outcome: "captured", correlationId: CORR });
  platform.payments.handleCallback({ paymentId: payment.payment_id, callbackId: "T-1", outcome: "captured", correlationId: CORR });
  const got = platform.payments.get(payment.payment_id);
  assert.equal(got.status, "captured");
  assert.equal(got.top_up, true);
});

test("跨服务超时：按该服务方策略重试，耗尽后反向补偿，退款与释放各只一次", async () => {
  const { platform, session } = bootPlatform();

  // 第一步：酒店占用成功；第二步：支付网关持续超时。
  let holdCalls = 0;
  const held = { id: null };
  const { correlationId } = platform.orchestration.define({
    sessionId: session.session_id,
    flowName: "酒店预订+扣款",
    steps: [
      {
        name: "占用酒店客房",
        provider: "hotel",
        recoveryHint: "可换一家酒店或稍后重试占位",
        action: async () => {
          holdCalls += 1;
          const r = platform.reservations.placeHold({
            sessionId: session.session_id,
            service: "hotel:pearl",
            provider: "hotel",
            resource: "ocean-901",
            idempotencyKey: "saga-hold-1",
            correlationId: CORR,
          });
          held.id = r.reservation.reservation_id;
          return r.reservation.reservation_id;
        },
        compensate: async ({ result }) => {
          platform.reservations.release(result, "支付超时，补偿释放客房", CORR);
        },
      },
      {
        name: "外卡支付网络扣款",
        provider: "payment_network",
        recoveryHint: "可更换卡片重试；若已扣款请勿重复支付，平台将自动核对退款",
        action: async () => {
          throw new RetryableError("支付网关响应超时", { timeout: true });
        },
      },
    ],
  });

  // 支付网络策略 max_attempts=4。
  assert.equal(policyOf("payment_network").retry.max_attempts, 4);
  const inst = await platform.orchestration.run(correlationId, {});
  assert.equal(inst.phase, "compensated");
  const payStep = inst.steps[1];
  assert.equal(payStep.attempt, 4);
  assert.equal(payStep.status, "failed_retryable");
  const hotelStep = inst.steps[0];
  assert.equal(hotelStep.status, "compensated");

  // 酒店占用只发生一次（动作只成功一次），补偿后资源释放。
  assert.equal(holdCalls, 1);
  assert.equal(platform.reservations.get(held.id).status, "released");

  // 事件证据：启动并完成补偿；步骤尝试次数被记录。
  const types = platform.events().filter((e) => e.correlation_id === correlationId).map((e) => e.event_type);
  assert(types.includes("COMPENSATION_STARTED"));
  assert(types.includes("COMPENSATION_COMPLETED"));
});

test("补偿可恢复：补偿动作先失败，恢复后续跑成功，且不重复回退", async () => {
  const { platform, session } = bootPlatform();
  const { payment } = platform.payments.initiate({
    sessionId: session.session_id,
    service: "hotel:pearl",
    clientPaymentId: "ORDER-SAGA-9",
    amount: 300,
    correlationId: CORR,
  });
  platform.payments.handleCallback({ paymentId: payment.payment_id, callbackId: "S-1", outcome: "captured", correlationId: CORR });

  let refundAttempts = 0;
  let refundGatewayDown = true;
  const { correlationId } = platform.orchestration.define({
    sessionId: session.session_id,
    flowName: "扣款后下游失败需退款",
    steps: [
      {
        name: "支付扣款",
        provider: "payment_network",
        action: async () => payment.payment_id,
        compensate: async () => {
          refundAttempts += 1;
          if (refundGatewayDown) throw new RetryableError("退款通道暂时不可用");
          platform.payments.refund(payment.payment_id, "下游不可用，补偿退款", CORR);
        },
      },
      {
        name: "锁定景点名额",
        provider: "attraction",
        action: async () => {
          throw new Error("名额已售罄"); // 非可重试错误，快速耗尽
        },
      },
    ],
  });

  let inst = await platform.orchestration.run(correlationId, {});
  assert.equal(inst.phase, "compensating");
  assert.equal(platform.payments.get(payment.payment_id).status, "captured"); // 尚未退成

  // 通道恢复后续跑。
  refundGatewayDown = false;
  inst = await platform.orchestration.resumeCompensation(correlationId, {});
  assert.equal(inst.phase, "compensated");
  assert.equal(platform.payments.get(payment.payment_id).status, "refunded");

  // 再续跑也是幂等的：退款不重复，状态保持 refunded，补偿完成事件不重复制造第二笔退款。
  await platform.orchestration.resumeCompensation(correlationId, {});
  assert.equal(platform.payments.get(payment.payment_id).status, "refunded");
  assert.equal(refundAttempts, 2); // 仅一次失败 + 一次成功；步骤已 compensated 后不再调用
});
