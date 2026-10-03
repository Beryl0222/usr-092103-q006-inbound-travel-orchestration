import { AggregateType, EventType } from "../domain.ts";
import { fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

/**
 * 服务授权域。
 *
 * 关键语义：
 * - 授权按（会话, 服务方, 用途范围）签发，范围外使用一律拒绝；
 * - 撤回（AUTHORIZATION_REVOKED）只阻断“之后”的用途：
 *   已完成的交易由 LEGAL_RECORD_HELD 登记法定留档，撤回不改写、不删除它们；
 * - 留档有独立 retain_until，留存到期清理时见 legalHold 仍保留（留存策略异构性在此显式化）。
 */
export class AuthorizationService {
  #store;
  #clock;
  #registry;
  #authz = new Map();

  constructor({ store, clock, registry }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    store.subscribe((e) => this.#apply(e));
  }

  #apply(event) {
    if (event.aggregate_type !== AggregateType.ServiceAuthorization) return;
    const a = this.#authz.get(event.aggregate_id) ?? {
      id: event.aggregate_id,
      status: "pending",
      scopes: [],
      completedUses: [],
    };
    switch (event.event_type) {
      case EventType.ServiceAuthorized:
        a.sessionId = event.payload.session_id;
        a.vaultId = event.payload.vault_id;
        a.partyId = event.payload.party_id;
        a.purpose = event.payload.purpose;
        a.scopes = event.payload.scopes;
        a.grantedAt = event.occurred_at;
        a.expiresAt = event.payload.expires_at;
        a.status = "active";
        break;
      case EventType.AuthorizationRevoked:
        a.status = "revoked";
        a.revokedAt = event.occurred_at;
        a.revokeReason = event.payload.reason;
        break;
      case EventType.LegalRecordHeld:
        a.completedUses.push({ ...event.payload, heldAt: event.occurred_at });
        break;
      default:
    }
    this.#authz.set(event.aggregate_id, a);
  }

  grant({ sessionId, vaultId, partyId, purpose, scopes, ttlMs = 24 * 3600 * 1000 }) {
    this.#registry.get(partyId);
    if (!Array.isArray(scopes) || scopes.length === 0)
      fail("INVALID_SCOPE", "授权至少包含一个用途范围");
    const authId = newId("auth");
    const expiresAt = new Date(this.#clock.epochMs() + ttlMs).toISOString();
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.ServiceAuthorized,
        aggregate_type: AggregateType.ServiceAuthorization,
        aggregate_id: authId,
        occurred_at: this.#clock.now(),
        version: 1,
        summary: `游客授权「${this.#registry.get(partyId).name}」用于 ${purpose}`,
        correlation_id: sessionId,
        payload: {
          session_id: sessionId,
          vault_id: vaultId,
          party_id: partyId,
          purpose,
          scopes,
          expires_at: expiresAt,
        },
      },
      0,
    );
    return this.#authz.get(authId);
  }

  get(authId) {
    const a = this.#authz.get(authId);
    if (!a) fail("AUTHORIZATION_NOT_FOUND", `授权不存在：${authId}`);
    return a;
  }

  /**
   * 后续用途前置检查。撤回/过期/超范围都拒绝；
   * 注意它只影响“新用途”——已完成交易的留档不经过这里，也不会被阻断。
   */
  assertUsable(authId, scope) {
    const a = this.get(authId);
    if (a.status === "revoked")
      fail("AUTHORIZATION_REVOKED", `授权已于 ${a.revokedAt} 撤回，不能再用于：${scope}`, {
        revokedAt: a.revokedAt,
      });
    if (Date.parse(a.expiresAt) <= this.#clock.epochMs())
      fail("AUTHORIZATION_EXPIRED", "授权已过期");
    if (!a.scopes.includes(scope))
      fail("SCOPE_DENIED", `授权范围不含：${scope}`, { granted: a.scopes });
    return a;
  }

  revoke(authId, reason = "游客主动撤回") {
    const a = this.get(authId);
    if (a.status === "revoked") return a; // 撤回幂等
    const version = this.#store.versionOf(AggregateType.ServiceAuthorization, authId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.AuthorizationRevoked,
        aggregate_type: AggregateType.ServiceAuthorization,
        aggregate_id: authId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `游客撤回对「${a.partyId}」的授权；已完成交易留档不受影响`,
        correlation_id: a.sessionId,
        payload: { reason, completed_uses_preserved: a.completedUses.length },
      },
      version,
    );
    return this.#authz.get(authId);
  }

  /**
   * 交易完成时登记法定留档（支付成功/预订确认/退税开单等终态后调用）。
   * 即使授权随后被撤回，这些记录仍保留到 retain_until。
   */
  holdLegalRecord(authId, { transactionRef, partyId, scope, retainUntil, reason }) {
    const a = this.get(authId);
    const version = this.#store.versionOf(AggregateType.ServiceAuthorization, authId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.LegalRecordHeld,
        aggregate_type: AggregateType.ServiceAuthorization,
        aggregate_id: authId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `已完成交易 ${transactionRef} 进入法定留档至 ${retainUntil}`,
        correlation_id: a.sessionId,
        payload: {
          hold_ref: newId("hold"),
          transaction_ref: transactionRef,
          party_id: partyId,
          scope,
          retain_until: retainUntil,
          reason,
        },
      },
      version,
    );
  }

  legalRecords(authId) {
    return this.get(authId).completedUses.map((u) => ({ ...u }));
  }
}
