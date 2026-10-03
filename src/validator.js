import { AGGREGATE_TYPES, EVENT_TYPES, SERVICE_PROVIDERS } from "./contracts.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 护照原件字段的特征名：任何事件负载出现这些键都视为身份扩散。 */
const RAW_IDENTITY_FIELD_PATTERNS = [
  /passport\s*no/i,
  /passport_number/i,
  /护照号/,
  /证件号/,
  /date\s*of\s*birth/i,
  /birth_date/i,
  /出生/,
  /nationality/i, // 国籍原件只允许在密封件内，资格断言只给布尔结果
  /surname|given_name|full_name/i,
  /mrtdata|mrz/i,
  /id_image|document_image|passport_image/i,
  /证件影像|护照影像|原件影像/,
];

/**
 * 校验事件是否满足消息边界契约。
 * @returns {string[]} 错误列表；空数组表示通过。
 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_id" in record && (typeof record.event_id !== "string" || !record.event_id)) {
    errors.push("event_id 必须是非空字符串");
  }
  if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || !record.aggregate_id)) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if ("summary" in record && (typeof record.summary !== "string" || !record.summary)) {
    errors.push("summary 必须是非空字符串");
  }
  if (record.payload && typeof record.payload !== "object") {
    errors.push("payload 必须是对象");
  }
  for (const leak of findIdentityLeaks(record.payload)) {
    errors.push(`身份扩散：事件负载不得携带护照原件字段（${leak}），请改用 sealed_ref`);
  }
  return errors;
}

/**
 * 前向兼容提示：未知枚举值不阻断解析（新生产方/旧消费方），只产生告警。
 * @returns {string[]} 告警列表。
 */
export function lintEvent(record) {
  const warnings = [];
  if (record.event_type && !EVENT_TYPES.includes(record.event_type)) {
    warnings.push(`未知 event_type（前向兼容放行）：${record.event_type}`);
  }
  if (record.aggregate_type && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    warnings.push(`未知 aggregate_type（前向兼容放行）：${record.aggregate_type}`);
  }
  if (record.service_provider && !SERVICE_PROVIDERS.includes(record.service_provider)) {
    warnings.push(`未知 service_provider（前向兼容放行）：${record.service_provider}`);
  }
  return warnings;
}

/** 递归扫描负载，返回命中的护照原件字段名。sealed_ref 引用本身合法。 */
export function findIdentityLeaks(node, path = "payload") {
  const hits = [];
  if (!node || typeof node !== "object") return hits;
  for (const [key, value] of Object.entries(node)) {
    const here = `${path}.${key}`;
    if (key !== "sealed_ref" && RAW_IDENTITY_FIELD_PATTERNS.some((re) => re.test(key))) {
      hits.push(here);
    }
    if (value && typeof value === "object") {
      hits.push(...findIdentityLeaks(value, here));
    }
  }
  return hits;
}
