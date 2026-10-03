import { AggregateType, EventType } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 旅客会话与服务授权登记。
 *
 * 授权模型：每条授权是 (服务方, 用途集合, 断言范围集合) 的显式同意。
 * 撤回是状态翻转而非删除：
 *  - 之后的断言签发、密封访问、后续用途一律拒绝（只阻断后续用途）；
 *  - 撤回前已完成的交易及其法定留档不受影响（legal_hold 材料继续留存）；
 *  - 授权记录本身保留，供游客看到“谁在什么时候获得过什么、何时被撤回”。
 */
export class SessionService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    /** @type {Map<string, any>} authorization_id -> auth */
    this.authorizations = new Map();
  }

  /**
   * 开启旅客会话并登记口岸护照核验结果。
   * 护照原件由调用方交给保险库密封，这里只收 sealed_ref。
   */
  startSession({ sealedRef, correlationId, channel = "provincial-entry-platform" }) {
    const sessionId = this.clock.id("sess");
    const session = {
      session_id: sessionId,
      correlation_id: correlationId ?? this.clock.id("corr"),
      status: "active",
      sealed_ref: sealedRef,
      channel,
      started_at: this.clock.now(),
      services: ["border_check"],
    };
    this.sessions.set(sessionId, session);

    const event = makeEvent(this.store, this.clock, {
      type: EventType.IdentityVerified,
      aggregateType: AggregateType.TravelerSession,
      aggregateId: sessionId,
      correlationId: session.correlation_id,
      provider: "border_check",
      summary: "护照核验通过，开启旅客会话（原件已密封）",
      payload: { session_id: sessionId, sealed_ref: sealedRef, services: ["border_check"] },
    });
    this.store.append(event);
    return session;
  }

  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : null;
  }

  /** 授予服务授权（重复授予同一组合时幂等回放既有授权）。 */
  grant({ sessionId, service, purposes, scopes }) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("会话不存在");
    const existing = [...this.authorizations.values()].find(
      (a) => a.session_id === sessionId && a.service === service && a.status === "active",
    );
    if (existing) return existing;

    const authorizationId = this.clock.id("auth");
    const state = {
      authorization_id: authorizationId,
      session_id: sessionId,
      service,
      purposes: [...purposes],
      scopes: [...scopes],
      status: "active",
      granted_at: this.clock.now(),
    };
    this.authorizations.set(authorizationId, state);
    if (!session.services.includes(service)) session.services.push(service);

    const event = makeEvent(this.store, this.clock, {
      type: EventType.ServiceAuthorized,
      aggregateType: AggregateType.ServiceAuthorization,
      aggregateId: authorizationId,
      correlationId: session.correlation_id,
      provider: "orchestrator",
      summary: `游客授权 ${service}：${purposes.join("、")}`,
      payload: {
        session_id: sessionId,
        service,
        purposes: [...purposes],
        assertion_scopes: [...scopes],
      },
    });
    this.store.append(event);
    return state;
  }

  /**
   * 撤回授权。返回更新后的授权。
   * @param {{authorizationId: string, reason: string}} opts
   */
  revoke({ authorizationId, reason }) {
    const auth = this.authorizations.get(authorizationId);
    if (!auth) throw new Error("授权不存在");
    if (auth.status === "revoked") return auth;
    auth.status = "revoked";
    auth.revoked_at = this.clock.now();
    auth.revoke_reason = reason;

    const session = this.sessions.get(auth.session_id);
    const event = makeEvent(this.store, this.clock, {
      type: EventType.AuthorizationRevoked,
      aggregateType: AggregateType.ServiceAuthorization,
      aggregateId: authorizationId,
      correlationId: session?.correlation_id,
      provider: "orchestrator",
      summary: `游客撤回 ${auth.service} 授权：${reason}（仅阻断后续用途，已完成交易留档不变）`,
      payload: {
        session_id: auth.session_id,
        service: auth.service,
        purposes: auth.purposes,
        assertion_scopes: auth.scopes,
        retained: true,
      },
    });
    this.store.append(event);
    return { ...auth };
  }

  /**
   * 判定服务方当前能否就 (purpose, scope) 使用身份数据。
   * 撤回后的授权一律拒绝；历史已完成动作不回溯。
   */
  isAuthorized(sessionId, service, purpose, scope) {
    return [...this.authorizations.values()].some(
      (a) =>
        a.session_id === sessionId &&
        a.service === service &&
        a.status === "active" &&
        a.purposes.includes(purpose) &&
        (scope === undefined || a.scopes.includes(scope)),
    );
  }

  listAuthorizations(sessionId) {
    return [...this.authorizations.values()].filter((a) => a.session_id === sessionId).map((a) => ({ ...a }));
  }
}
