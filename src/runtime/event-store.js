import { validateEvent } from "../validator.js";

/**
 * 仅追加事件存储。所有状态变更都以领域事件落账：
 * - aggregate 版本号乐观并发控制；
 * - event_id 唯一，重复提交直接回放既有事件（消息重投安全）；
 * - 订阅者同步分发，编排引擎据此驱动后续步骤。
 */
export class EventStore {
  constructor() {
    /** @type {Map<string, any[]>} aggregate_id -> events */
    this.streams = new Map();
    /** @type {Map<string, any>} event_id -> event */
    this.byId = new Map();
    /** @type {Map<string, any>} idempotency_key -> event */
    this.byIdempotencyKey = new Map();
    this.subscribers = new Set();
    /** @type {any[]} 全局顺序，用于测试与审计导出 */
    this.all = [];
  }

  /**
   * 追加事件。
   * @param {any} event 完整信封（version 应为该聚合的下一版本）。
   * @param {{idempotencyKey?: string}} [opts]
   * @returns {{event: any, replayed: boolean}}
   */
  append(event, opts = {}) {
    const envelopeErrors = validateEvent(event);
    if (envelopeErrors.length) throw new Error(`事件违反契约：${envelopeErrors.join("；")}`);

    if (this.byId.has(event.event_id)) {
      return { event: this.byId.get(event.event_id), replayed: true };
    }
    if (opts.idempotencyKey) {
      const existing = this.byIdempotencyKey.get(opts.idempotencyKey);
      if (existing) return { event: existing, replayed: true };
      this.byIdempotencyKey.set(opts.idempotencyKey, event);
    }

    const stream = this.streams.get(event.aggregate_id) ?? [];
    const expected = stream.length + 1;
    if (event.version !== expected) {
      throw new Error(`版本冲突：${event.aggregate_id} 期望 v${expected}，收到 v${event.version}`);
    }
    stream.push(event);
    this.streams.set(event.aggregate_id, stream);
    this.byId.set(event.event_id, event);
    this.all.push(event);

    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* 订阅者失败不得破坏落账；其重试由各自读模型负责 */
      }
    }
    return { event, replayed: false };
  }

  streamOf(aggregateId) {
    return [...(this.streams.get(aggregateId) ?? [])];
  }

  versionOf(aggregateId) {
    return (this.streams.get(aggregateId) ?? []).length;
  }

  /** 跨服务追踪：按 correlation_id 抽取脱敏事件序列。 */
  traceByCorrelation(correlationId) {
    return this.all.filter((e) => e.correlation_id === correlationId);
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
