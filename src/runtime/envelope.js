import { validateEvent } from "../validator.js";

/**
 * 构造并校验领域事件信封。payload 经契约校验：护照原件字段不得出现。
 */
export function makeEvent(
  store,
  clock,
  { type, aggregateType, aggregateId, summary, correlationId, causationId, idempotencyKey, provider, payload = {} },
) {
  const event = {
    event_id: clock.id("evt"),
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: clock.now(),
    version: store.versionOf(aggregateId) + 1,
    summary,
  };
  if (correlationId) event.correlation_id = correlationId;
  if (causationId) event.causation_id = causationId;
  if (idempotencyKey) event.idempotency_key = idempotencyKey;
  if (provider) event.service_provider = provider;
  if (Object.keys(payload).length) event.payload = payload;
  const errors = validateEvent(event);
  if (errors.length) throw new Error(`事件违反契约：${errors.join("；")}`);
  return event;
}
