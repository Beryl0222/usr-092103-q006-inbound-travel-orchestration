import { readFileSync } from "node:fs";

const schema = JSON.parse(
  readFileSync(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"),
);

const required = schema.required;
const eventTypes = new Set(schema.properties.event_type.enum);
const aggregateTypes = new Set(schema.properties.aggregate_type.enum);

/**
 * 校验领域事件信封。返回中文错误信息数组，空数组表示通过。
 * 枚举取值以 contracts/domain.schema.json 为唯一来源，避免与契约漂移。
 */
export function validateEvent(record) {
  const errors = required
    .filter((name) => record == null || !(name in record))
    .map((name) => `缺少字段：${name}`);
  if (record == null || typeof record !== "object") return errors;

  if ("event_id" in record && (typeof record.event_id !== "string" || !record.event_id))
    errors.push("event_id 必须是非空字符串");
  if ("event_type" in record && !eventTypes.has(record.event_type))
    errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !aggregateTypes.has(record.aggregate_type))
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || !record.aggregate_id))
    errors.push("aggregate_id 必须是非空字符串");
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1))
    errors.push("version 必须是正整数");
  if (
    "occurred_at" in record &&
    (typeof record.occurred_at !== "string" || Number.isNaN(Date.parse(record.occurred_at)))
  )
    errors.push("occurred_at 必须是合法的 date-time");
  if ("summary" in record && (typeof record.summary !== "string" || !record.summary))
    errors.push("summary 必须是非空字符串");
  if ("payload" in record && (record.payload == null || typeof record.payload !== "object"))
    errors.push("payload 必须是对象");
  for (const name of ["causation_id", "correlation_id"]) {
    if (name in record && (typeof record[name] !== "string" || !record[name]))
      errors.push(`${name} 必须是非空字符串`);
  }
  return errors;
}
