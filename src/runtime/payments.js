import { AggregateType, EventType } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 支付与外卡充值服务。
 *
 * 幂等与防重：
 *  - 同一 payment 的扣款只发生一次；captured/failed 为终态（退款除外）。
 *  - 外部回调以 callback_id 去重：重复回调回放首次结果并发 CALLBACK_DEDUPED，
 *    网络重投、人工补单都不会二次扣款。
 *  - 外卡充值沿用同一状态机（TOPUP_REQUESTED / TOPUP_COMPLETED）。
 *  - 交易凭证属于法定留档：授权撤回或退款不删除账本，只改变状态。
 */
export class PaymentService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    /** @type {Map<string, any>} */
    this.payments = new Map();
    /** callback_key (`${payment_id}:${callbackId}`) -> 首次处理事件标识 */
    this.callbacks = new Map();
  }

  /**
   * 发起支付/充值（幂等：同一 clientPaymentId 回放）。
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} args.service 收款服务方
   * @param {string} args.clientPaymentId 业务侧幂等键（如订单号）
   * @param {number} args.amount
   * @param {string} [args.currency]
   * @param {boolean} [args.topUp] 是否为外卡充值
   * @param {string} args.correlationId
   */
  initiate({ sessionId, service, clientPaymentId, amount, currency = "CNY", topUp = false, correlationId }) {
    for (const p of this.payments.values()) {
      if (p.client_payment_id === clientPaymentId) {
        return { payment: this.#external(p), replayed: true };
      }
    }
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("金额必须为正数");

    const paymentId = this.clock.id("pay");
    const state = {
      payment_id: paymentId,
      client_payment_id: clientPaymentId,
      session_id: sessionId,
      service,
      amount,
      currency,
      top_up: topUp,
      status: "initiated",
      processed_callbacks: {},
      legal_hold: true,
      created_at: this.clock.now(),
    };
    this.payments.set(paymentId, state);

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: topUp ? EventType.TopupRequested : EventType.PaymentInitiated,
        aggregateType: AggregateType.Payment,
        aggregateId: paymentId,
        correlationId,
        idempotencyKey: clientPaymentId,
        provider: "payment_network",
        summary: `${topUp ? "外卡充值" : "支付"}发起：${amount} ${currency} @ ${service}`,
        payload: {
          session_id: sessionId,
          service,
          payment_id: paymentId,
          amount,
          currency,
        },
      }),
      { idempotencyKey: clientPaymentId },
    );
    return { payment: this.#external(state), replayed: false };
  }

  /**
   * 接收外部支付网络回调。重复回调安全：
   * 首次按结果落账；之后只回放并记 CALLBACK_DEDUPED，绝不重复入账。
   * @param {object} args
   * @param {string} args.paymentId
   * @param {string} args.callbackId 回调方唯一标识（通知流水号）
   * @param {"captured"|"failed"} args.outcome
   * @param {string} args.correlationId
   * @param {string} [args.reason]
   */
  handleCallback({ paymentId, callbackId, outcome, correlationId, reason }) {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error("支付不存在");
    const key = `${paymentId}:${callbackId}`;

    const prior = this.callbacks.get(key);
    if (prior) {
      this.store.append(
        makeEvent(this.store, this.clock, {
          type: EventType.CallbackDeduped,
          aggregateType: AggregateType.Payment,
          aggregateId: paymentId,
          correlationId,
          causationId: prior,
          provider: "payment_network",
          summary: `重复回调 ${callbackId} 已去重，维持 ${p.status}，未重复扣款`,
          payload: {
            session_id: p.session_id,
            service: p.service,
            payment_id: paymentId,
            replay_outcome: outcome,
          },
        }),
      );
      return { payment: this.#external(p), deduped: true };
    }

    if (!["captured", "failed"].includes(outcome)) throw new Error("未知回调结果");
    let eventType;
    if (outcome === "captured") {
      if (p.status === "captured") {
        // 不同 callbackId 但已扣款：仍按去重处理，防止二充。
        this.callbacks.set(key, "already-terminal");
        return this.#dedupFallback(p, callbackId, correlationId);
      }
      p.status = "captured";
      p.captured_at = this.clock.now();
      eventType = p.top_up ? EventType.TopupCompleted : EventType.PaymentCaptured;
    } else {
      if (p.status === "captured") {
        // 已扣款又来失败通知：不得改写成功状态，转人工争议处理。
        this.callbacks.set(key, "conflict");
        const err = new Error("回调冲突：支付已扣款，收到失败通知，挂起人工处理");
        err.code = "PAYMENT_CONFLICT";
        throw err;
      }
      p.status = "failed";
      p.failure_reason = reason;
      eventType = EventType.PaymentFailed;
    }
    p.processed_callbacks[callbackId] = outcome;

    const event = makeEvent(this.store, this.clock, {
      type: eventType,
      aggregateType: AggregateType.Payment,
      aggregateId: paymentId,
      correlationId,
      provider: "payment_network",
      summary:
        outcome === "captured"
          ? `${p.top_up ? "充值" : "支付"}成功扣款 ${p.amount} ${p.currency}（回调 ${callbackId}）`
          : `${p.top_up ? "充值" : "支付"}失败（回调 ${callbackId}）：${reason ?? "未知原因"}`,
      payload: {
        session_id: p.session_id,
        service: p.service,
        payment_id: paymentId,
        retained: true,
        legal_hold: true,
      },
    });
    this.store.append(event);
    this.callbacks.set(key, event.event_id);
    return { payment: this.#external(p), deduped: false };
  }

  /** 补偿用：原路退款（仅已扣款可退；重复调用幂等）。 */
  refund(paymentId, reason, correlationId) {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error("支付不存在");
    if (p.status === "refunded") return this.#external(p);
    if (p.status !== "captured") throw new Error(`仅已扣款可退，当前 ${p.status}`);
    p.status = "refunded";
    p.refunded_at = this.clock.now();
    p.refund_reason = reason;

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.PaymentRefunded,
        aggregateType: AggregateType.Payment,
        aggregateId: paymentId,
        correlationId,
        provider: "payment_network",
        summary: `补偿退款 ${p.amount} ${p.currency}：${reason}（账本留档保留）`,
        payload: {
          session_id: p.session_id,
          service: p.service,
          payment_id: paymentId,
          retained: true,
          legal_hold: true,
        },
      }),
    );
    return this.#external(p);
  }

  get(paymentId) {
    const p = this.payments.get(paymentId);
    return p ? this.#external(p) : null;
  }

  #dedupFallback(p, callbackId, correlationId) {
    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.CallbackDeduped,
        aggregateType: AggregateType.Payment,
        aggregateId: p.payment_id,
        correlationId,
        provider: "payment_network",
        summary: `迟到回调 ${callbackId}：支付已扣款，去重放行，不二次扣款`,
        payload: { session_id: p.session_id, service: p.service, payment_id: p.payment_id },
      }),
    );
    return { payment: this.#external(p), deduped: true };
  }

  #external(p) {
    return { ...p, processed_callbacks: { ...p.processed_callbacks } };
  }
}
