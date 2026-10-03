import { validateEvent } from "../validator.js";
import { fail } from "./errors.js";

/**
 * 仅追加（append-only）领域事件存储。
 *
 * 边界保证：
 * - 每个聚合独立版本号，append 时 expectedVersion 做乐观并发控制；
 * - event_id 全局唯一，重复提交被拒绝（与回调幂等表配合实现“重复回调不二次生效”）；
 * - 订阅者按写入顺序同步收到事件，投影与编排器据此重建状态；
 * - 不提供就地更新：撤回、作废、补偿一律以新事件表达。
 */
export class EventStore {
  #events = [];
  #byAggregate = new Map();
  #seenIds = new Set();
  #subscribers = [];

  subscribe(handler) {
    this.#subscribers.push(handler);
    return () => {
      this.#subscribers = this.#subscribers.filter((h) => h !== handler);
    };
  }

  /** 追加事件。expectedVersion 为该聚合一追加前的版本号（首个事件传 0）。 */
  append(event, expectedVersion) {
    const errors = validateEvent(event);
    if (errors.length) fail("INVALID_EVENT", `事件 ${event?.event_type ?? "?" } 校验失败`, { errors });
    if (this.#seenIds.has(event.event_id)) {
      return fail(
        "EVENT_ID_CONFLICT",
        `事件编号已存在：${event.event_id}`,
      );
    }
    const key = event.aggregate_type + "/" + event.aggregate_id;
    const current = this.#byAggregate.get(key) ?? 0;
    if (expectedVersion !== current) {
      fail("VERSION_CONFLICT", `聚合 ${key} 版本冲突：期望 ${expectedVersion}，实际 ${current}`, {
        expected: expectedVersion,
        actual: current,
      });
    }
    this.#events.push(event);
    this.#byAggregate.set(key, current + 1);
    this.#seenIds.add(event.event_id);
    for (const handler of this.#subscribers) handler(event);
    return event;
  }

  /** 读取某聚合的事件流（按版本顺序）。 */
  loadStream(aggregateType, aggregateId) {
    const key = aggregateType + "/" + aggregateId;
    return this.#events.filter(
      (e) => e.aggregate_type + "/" + e.aggregate_id === key,
    );
  }

  versionOf(aggregateType, aggregateId) {
    return this.#byAggregate.get(aggregateType + "/" + aggregateId) ?? 0;
  }

  all() {
    return [...this.#events];
  }

  /** 按 correlation_id 还原跨服务调用链（运维排障用）。 */
  trace(correlationId) {
    return this.#events.filter((e) => e.correlation_id === correlationId);
  }
}
