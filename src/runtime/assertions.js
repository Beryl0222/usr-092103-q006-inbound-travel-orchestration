import { AggregateType, AssertionScope, EventType } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 最小身份断言签发器。
 * 商户“只需确认资格”时只能得到资格断言，例如：
 *   { scope: "entry_eligibility", result: true }
 * 护照号、姓名、出生日期等原件字段在保险库内参与判定，但绝不进入断言或事件。
 *
 * 断言绑定 (会话, 服务方, 用途, 范围)，随授权撤回而失效；
 * 已完成交易的法定留档不依赖断言的有效性。
 */
export class AssertionService {
  constructor(store, clock, vault) {
    this.store = store;
    this.clock = clock;
    this.vault = vault;
    /** @type {Map<string, any>} assertion_id -> 断言状态 */
    this.assertions = new Map();
  }

  /**
   * 签发最小断言。调用方必须先确认授权有效。
   * @param {object} args
   * @param {string} args.sealedRef 护照密封件引用
   * @param {string} args.sessionId
   * @param {string} args.service 请求方
   * @param {string} args.purpose 用途说明
   * @param {string} args.scope AssertionScope
   * @param {boolean} args.authorized 授权服务对该 (service,purpose,scope) 的判定
   */
  issue({ sealedRef, sessionId, service, purpose, scope, authorized }) {
    if (!authorized) {
      const err = new Error(`授权缺失：${service} 不能就用途「${purpose}」取得 ${scope}`);
      err.code = "NOT_AUTHORIZED";
      throw err;
    }
    // 在保险库内完成判定：原件不出库。
    const result = this.#evaluate(sealedRef, scope, service, purpose);

    const assertionId = this.clock.id("assert");
    const state = {
      assertion_id: assertionId,
      session_id: sessionId,
      service,
      purpose,
      scope,
      result,
      status: "valid",
      issued_at: this.clock.now(),
    };
    this.assertions.set(assertionId, state);

    const event = makeEvent(this.store, this.clock, {
      type: EventType.IdentityAssertionIssued,
      aggregateType: AggregateType.IdentityAssertion,
      aggregateId: assertionId,
      provider: "border_check",
      summary: `向 ${service} 签发最小身份断言：${scope}`,
      payload: {
        session_id: sessionId,
        service,
        purposes: [purpose],
        assertion_scopes: [scope],
        sealed_ref: sealedRef, // 只有引用，没有任何原件字段
        result,
      },
    });
    this.store.append(event);
    return state;
  }

  /** 授权撤回时联动失效断言；事件中记录原因。 */
  invalidate(assertionId, reason) {
    const a = this.assertions.get(assertionId);
    if (!a || a.status !== "valid") return null;
    a.status = "invalid";
    a.invalidated_at = this.clock.now();
    const event = makeEvent(this.store, this.clock, {
      type: EventType.IdentityAssertionRevoked,
      aggregateType: AggregateType.IdentityAssertion,
      aggregateId: assertionId,
      provider: "orchestrator",
      summary: `断言失效：${reason}`,
      payload: {
        session_id: a.session_id,
        service: a.service,
        purposes: [a.purpose],
        assertion_scopes: [a.scope],
      },
    });
    this.store.append(event);
    return a;
  }

  isValid(assertionId) {
    const a = this.assertions.get(assertionId);
    return Boolean(a && a.status === "valid");
  }

  get(assertionId) {
    const a = this.assertions.get(assertionId);
    return a ? { ...a } : null;
  }

  listFor(sessionId) {
    return [...this.assertions.values()].filter((a) => a.session_id === sessionId).map((a) => ({ ...a }));
  }

  /**
   * 库内判定规则（演示）。原件在 vault 内部解开，返回值只有布尔或化名。
   */
  #evaluate(sealedRef, scope, service, purpose) {
    const raw = this.vault.accessSealed(sealedRef, {
      service: "border_check",
      purpose: `库内派生断言 ${scope}（请求方 ${service}/${purpose}）`,
      actor: "assertion-service",
      authorized: true,
    });
    const age = ageInYears(raw.date_of_birth);
    switch (scope) {
      case AssertionScope.EntryEligibility:
        // 已由口岸核验事件背书，这里只做资格固化。
        return true;
      case AssertionScope.AdultStatus:
        return age >= 18;
      case AssertionScope.HotelRegistrationAlias:
        // 化名而非真实姓名原件：登记本留档由酒店按其保留规则另存密封件。
        return `入住宾客 ${(raw.surname ?? "GUEST").slice(0, 1)}.（化名编号 ${Math.abs(hash(raw.passport_number ?? "")).toString(36).slice(0, 6)}）`;
      case AssertionScope.TaxRefundEligibility:
        return raw.visa_class === "tourist_short_stay" && age >= 18;
      case AssertionScope.PaymentKycReceipt:
        return { kyc: "passed-by-issuer", receipt: true };
      default:
        throw new Error(`未知断言范围：${scope}`);
    }
  }
}

function ageInYears(dob) {
  if (!dob) return 0;
  const birth = new Date(dob);
  const now = new Date("2026-10-03T00:00:00Z");
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
