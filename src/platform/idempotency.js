/**
 * 入站幂等记录表。
 *
 * 外部服务方的回调/重试可能携带同一 idempotency_key 多次到达。
 * 第一次处理结果被记录；后续同键请求直接返回首次结果，绝不重复扣款或重复占位。
 * 键的作用域为（服务方, 键），避免不同服务方的内部编号相互碰撞。
 */
export class IdempotencyTable {
  #records = new Map();

  static key(partyId, idempotencyKey) {
    return partyId + "::" + idempotencyKey;
  }

  /**
   * 只在首次见到该键时执行 producer；之后重放首次结果。
   * producer 必须同步完成并返回可复用结果；它抛出的错误也会被记录并重放。
   */
  once(partyId, idempotencyKey, producer) {
    const k = IdempotencyTable.key(partyId, idempotencyKey);
    const existing = this.#records.get(k);
    if (existing) return existing.result;
    // producer 抛出代表“结果未知”（超时/传输故障），不固化；编排层挂起并对账，
    // 期间对方重放同一回调时仍由本方法挡住，不会执行第二次副作用。
    const result = producer();
    if (result === undefined) {
      throw new Error("幂等 producer 必须返回终态结果，不得返回 undefined");
    }
    this.#records.set(k, { result, at: new Date().toISOString() });
    return result;
  }

  has(partyId, idempotencyKey) {
    return this.#records.has(IdempotencyTable.key(partyId, idempotencyKey));
  }

  replay(partyId, idempotencyKey) {
    return this.#records.get(IdempotencyTable.key(partyId, idempotencyKey))?.result;
  }
}
