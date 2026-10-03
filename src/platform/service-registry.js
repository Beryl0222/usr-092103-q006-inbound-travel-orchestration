import { fail } from "./errors.js";

/**
 * 服务方注册表：平台为每个外部服务保存三类异构策略，
 * 这些策略正是“同一入口、各服务方规则不同”的显式建模：
 *
 * - identityPolicy：该服务方允许收到的身份字段白名单。
 *   只需确认资格的商户（如酒店核验签证资格）拿不到护照号/出生日期等原件字段。
 * - retryPolicy：超时、最大尝试次数与退避基数；编排器按服务方而非全局重试。
 * - retentionPolicy：数据保留天数；legalHold=true 的记录即使到期也由法定留档事件接管。
 *
 * adapter：供演示/测试的内存适配器，实现 confirm/reserve/charge/recognize 等远程动作。
 */
export class ServiceRegistry {
  #parties = new Map();

  register(party) {
    for (const field of ["id", "kind", "name"]) {
      if (!party?.[field]) fail("INVALID_PARTY", `服务方缺少字段：${field}`);
    }
    const normalized = {
      ...party,
      identityPolicy: { allowedFields: [], requiresPassportAccess: false, ...party.identityPolicy },
      retryPolicy: { timeoutMs: 5_000, maxAttempts: 3, backoffBaseMs: 500, ...party.retryPolicy },
      retentionPolicy: { days: 90, legalHold: false, ...party.retentionPolicy },
    };
    normalized.identityPolicy.allowedFields = new Set(normalized.identityPolicy.allowedFields);
    this.#parties.set(normalized.id, normalized);
    return normalized;
  }

  get(partyId) {
    const p = this.#parties.get(partyId);
    if (!p) fail("UNKNOWN_PARTY", `未登记的服务方：${partyId}`);
    return p;
  }

  list() {
    return [...this.#parties.values()];
  }

  /** 该服务方是否可以接收指定护照字段（用于最小断言裁剪）。 */
  canReceiveField(partyId, field) {
    return this.get(partyId).identityPolicy.allowedFields.has(field);
  }
}
