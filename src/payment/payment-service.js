import { AggregateType, EventType } from "../domain.ts";
import { fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

/**
 * 支付域（外卡充值、预订收款等统一走此聚合）。
 *
 * 状态机：pending → succeeded | failed；succeeded → refunded。
 *
 * 防重复扣款：
 * - 发起支付带 idempotency_key（外卡网络重试时同键回放同一笔支付单）；
 * - 渠道回调带 callback_id，经幂等表只生效一次，重复回调直接回放首次终态；
 * - 终态冲突（先成功后失败之类）拒绝并留痕，钱的状态以首个终态为准；
 * - 退款同样要求 refund_key，补偿流程重复触发不会退两次。
 */
export class PaymentService {
  #store;
  #clock;
  #registry;
  #idempotency;
  #payments = new Map();

  constructor({ store, clock, registry, idempotency }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    this.#idempotency = idempotency;
    store.subscribe((e) => this.#apply(e));
  }

  #apply(event) {
    if (event.aggregate_type !== AggregateType.Payment) return;
    const p = event.payload;
    const pay = this.#payments.get(event.aggregate_id) ?? { id: event.aggregate_id, callbacks: {}, refunds: {} };
    switch (event.event_type) {
      case EventType.PaymentInitiated:
        pay.sessionId = p.session_id;
        pay.partyId = p.party_id;
        pay.purpose = p.purpose;
        pay.refType = p.ref_type;
        pay.refId = p.ref_id;
        pay.amount = p.amount;
        pay.method = p.method;
        pay.status = "pending";
        pay.initiatedAt = event.occurred_at;
        break;
      case EventType.PaymentSucceeded:
        pay.status = "succeeded";
        pay.gatewayRef = p.gateway_ref;
        pay.succeededAt = event.occurred_at;
        if (p.callback_id) pay.callbacks[p.callback_id] = "succeeded";
        break;
      case EventType.PaymentFailed:
        pay.status = "failed";
        pay.failReason = p.reason;
        pay.failedAt = event.occurred_at;
        if (p.callback_id) pay.callbacks[p.callback_id] = "failed";
        break;
      case EventType.PaymentRefunded:
        pay.status = "refunded";
        pay.refunds[p.refund_key] = { amount: p.amount, at: event.occurred_at, reason: p.reason };
        break;
      default:
    }
    this.#payments.set(event.aggregate_id, pay);
  }

  /** 发起支付；同一 idempotencyKey 的网络重试回放同一支付单，绝不产生第二笔。 */
  initiate({ sessionId, partyId, purpose, amount, currency, method = "foreign_card", refType = null, refId = null, idempotencyKey }) {
    this.#registry.get(partyId);
    if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED", "发起支付必须带 idempotency_key");
    if (!Number.isFinite(amount) || amount <= 0) fail("INVALID_AMOUNT", "支付金额必须为正数");
    return this.#idempotency.once(partyId, idempotencyKey, () => {
      const id = newId("pay");
      this.#store.append(
        {
          event_id: newId("evt"),
          event_type: EventType.PaymentInitiated,
          aggregate_type: AggregateType.Payment,
          aggregate_id: id,
          occurred_at: this.#clock.now(),
          version: 1,
          summary: `外卡${purpose === "wallet_topup" ? "充值" : "支付"} ${amount} ${currency}（${purpose}）`,
          correlation_id: sessionId,
          payload: {
            session_id: sessionId,
            party_id: partyId,
            purpose,
            ref_type: refType,
            ref_id: refId,
            amount: { amount, currency },
            method,
          },
        },
        0,
      );
      return this.get(id);
    });
  }

  /** 渠道异步回调。重复 callback_id 回放首次结果；与已落定终态冲突时拒绝。 */
  resultCallback(partyId, { callbackId, paymentId, outcome, gatewayRef, reason }) {
    const pay = this.get(paymentId);
    if (pay.partyId !== partyId) fail("PARTY_MISMATCH", "回调服务方与收单服务方不一致");
    if (!["succeeded", "failed"].includes(outcome)) fail("INVALID_OUTCOME", `未知支付结果：${outcome}`);
    return this.#idempotency.once(partyId, callbackId, () => {
      // 不同 callback_id 但同终态的重发（网关换编号重试）：回声已有结果，不产生第二笔影响。
      if (pay.status === outcome) return this.get(paymentId);
      if (pay.status === "succeeded" || pay.status === "failed") {
        // 同一支付先成功后失败（或相反）属于冲突，钱的状态以首个终态为准。
        fail("PAYMENT_TERMINAL_CONFLICT", `支付已是终态 ${pay.status}，不能改为 ${outcome}`, {
          current: pay.status,
          attempted: outcome,
        });
      }
      const version = this.#store.versionOf(AggregateType.Payment, paymentId);
      this.#store.append(
        {
          event_id: newId("evt"),
          event_type: outcome === "succeeded" ? EventType.PaymentSucceeded : EventType.PaymentFailed,
          aggregate_type: AggregateType.Payment,
          aggregate_id: paymentId,
          occurred_at: this.#clock.now(),
          version: version + 1,
          summary:
            outcome === "succeeded"
              ? `支付成功（渠道流水 ${gatewayRef ?? "?"}）`
              : `支付失败：${reason ?? "未说明"}`,
          correlation_id: pay.sessionId,
          causation_id: callbackId,
          payload: {
            callback_id: callbackId,
            gateway_ref: gatewayRef ?? null,
            reason: reason ?? null,
          },
        },
        version,
      );
      return this.get(paymentId);
    });
  }

  /** 退款（补偿用）。refundKey 去重：重复补偿不会退第二次。 */
  refund(paymentId, refundKey, reason = "编排补偿") {
    const pay = this.get(paymentId);
    return this.#idempotency.once(pay.partyId, refundKey, () => {
      if (pay.status === "refunded") fail("ALREADY_REFUNDED", "支付已退款");
      if (pay.status !== "succeeded") fail("REFUND_NOT_POSSIBLE", `只有成功支付可退，当前状态：${pay.status}`);
      const version = this.#store.versionOf(AggregateType.Payment, paymentId);
      this.#store.append(
        {
          event_id: newId("evt"),
          event_type: EventType.PaymentRefunded,
          aggregate_type: AggregateType.Payment,
          aggregate_id: paymentId,
          occurred_at: this.#clock.now(),
          version: version + 1,
          summary: `退款 ${pay.amount.amount} ${pay.amount.currency}：${reason}`,
          correlation_id: pay.sessionId,
          payload: { refund_key: refundKey, amount: pay.amount, reason },
        },
        version,
      );
      return this.get(paymentId);
    });
  }

  get(paymentId) {
    const pay = this.#payments.get(paymentId);
    if (!pay) fail("PAYMENT_NOT_FOUND", `支付单不存在：${paymentId}`);
    return structuredClone(pay);
  }
}
