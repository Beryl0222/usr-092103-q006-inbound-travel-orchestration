import { AssertionScope, RetentionClass } from "../contracts.js";
import { Clock } from "./clock.js";
import { EventStore } from "./event-store.js";
import { IdentityVault } from "./identity-vault.js";
import { AssertionService } from "./assertions.js";
import { SessionService } from "./sessions.js";
import { ReservationService } from "./reservations.js";
import { ItineraryService } from "./itinerary.js";
import { PaymentService } from "./payments.js";
import { TranslationService } from "./translation.js";
import { TaxRefundService } from "./tax-refund.js";
import { OrchestrationEngine, RetryableError } from "./orchestration.js";
import { Views } from "./views.js";

/**
 * 省级入境游编排平台装配根。
 * 各领域服务共享同一仅追加事件存储；消息边界为 contracts/domain.schema.json。
 */
export class Platform {
  constructor(clock = new Clock()) {
    this.clock = clock;
    this.store = new EventStore();
    this.vault = new IdentityVault(this.store, clock);
    this.sessions = new SessionService(this.store, clock);
    this.assertions = new AssertionService(this.store, clock, this.vault);
    this.reservations = new ReservationService(this.store, clock);
    this.itinerary = new ItineraryService(this.store, clock);
    this.payments = new PaymentService(this.store, clock);
    this.translation = new TranslationService(this.store, clock);
    this.taxRefund = new TaxRefundService(this.store, clock, this.vault);
    this.orchestration = new OrchestrationEngine(this.store, clock);
    this.views = new Views({
      store: this.store,
      vault: this.vault,
      sessions: this.sessions,
      assertions: this.assertions,
      reservations: this.reservations,
      itinerary: this.itinerary,
      payments: this.payments,
      translation: this.translation,
      taxRefund: this.taxRefund,
      orchestration: this.orchestration,
    });
  }

  /** 入口：护照核验。原件在此密封，平台其余部分只见引用。 */
  verifyPassport({ rawPassport, ttlMs = 1000 * 60 * 60 * 24 * 30 }) {
    const sealedRef = this.vault.sealPassport(rawPassport, {
      sessionId: "pending", // 会话尚未建立，先占位，startSession 后回填
      retentionClass: RetentionClass.SessionWorking,
      ttlMs,
      source: "border_check",
    });
    const session = this.sessions.startSession({ sealedRef });
    // 回填密封件归属。
    const seal = this.vault.seals.get(sealedRef);
    seal.session_id = session.session_id;
    return { session, sealedRef };
  }

  /** 授权 + 按需一次性派生最小断言的便捷入口（先验授权再签发）。 */
  authorizeAndAssert({ sessionId, service, purposes, scope }) {
    this.sessions.grant({ sessionId, service, purposes, scopes: [scope] });
    const session = this.sessions.getSession(sessionId);
    return this.assertions.issue({
      sealedRef: session.sealed_ref,
      sessionId,
      service,
      purpose: purposes[0],
      scope,
      authorized: this.sessions.isAuthorized(sessionId, service, purposes[0], scope),
    });
  }

  /**
   * 游客撤回某项授权：
   *  - 该服务的全部有效断言立即失效；
   *  - 退税后续报送被阻断；
   *  - 已完成预订/支付/退税材料的法定留档原样保留（事件显式注明）。
   */
  revokeAuthorization({ authorizationId, reason }) {
    const auth = this.sessions.revoke({ authorizationId, reason });
    for (const a of this.assertions.listFor(auth.session_id)) {
      if (a.service === auth.service && a.status === "valid") {
        this.assertions.invalidate(a.assertion_id, reason);
      }
    }
    for (const pack of this.taxRefund.listBySession(auth.session_id)) {
      if (auth.scopes.includes(AssertionScope.TaxRefundEligibility) || auth.service === "tax_refund") {
        this.taxRefund.blockFurtherUse(pack.pack_id);
      }
    }
    return auth;
  }

  /** 执行保留清理（各服务方保留规则见 policies.js 与密封件 retention_class）。 */
  sweepRetention() {
    return this.vault.sweep();
  }

  /** 导出全部事件（测试/审计）。 */
  events() {
    return [...this.store.all];
  }
}

export { RetryableError };
