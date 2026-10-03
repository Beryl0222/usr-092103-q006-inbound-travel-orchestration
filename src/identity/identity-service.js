import { AggregateType, EventType } from "../domain.ts";
import { EventStore } from "../platform/event-store.js";
import { fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

/**
 * 身份域：旅客会话 + 护照隔离 vault + 最小化身份断言。
 *
 * 数据流原则：
 * - 护照原件字段只在 IDENTITY_VERIFIED 时进入一次 vault 投影，之后通过
 *   issueAssertion 按服务方白名单裁剪后外发；事件流中的原件事件也受 vault 边界保护。
 * - 酒店等“只需确认资格”的商户拿到的是资格结论（visa_valid / adult），
 *   不是护照号、出生日期等原件字段。
 * - 任何对原件的读取（含边检/退税等少数授权方）都产生 PASSPORT_ACCESSED 审计事件。
 */
export class IdentityService {
  #store;
  #clock;
  #registry;
  #sessions = new Map();
  #vaults = new Map();

  constructor({ store, clock, registry }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    store.subscribe((e) => this.#apply(e));
  }

  #apply(event) {
    if (event.aggregate_type === AggregateType.TravelerSession) {
      const s = this.#sessions.get(event.aggregate_id) ?? { id: event.aggregate_id, verified: false };
      if (event.event_type === EventType.SessionOpened) {
        s.openedAt = event.occurred_at;
        s.locale = event.payload.locale;
        s.entryPoint = event.payload.entry_point;
      }
      if (event.event_type === EventType.IdentityVerified) {
        s.verified = true;
        s.vaultId = event.payload.vault_id;
      }
      this.#sessions.set(event.aggregate_id, s);
    }
    if (event.aggregate_type === AggregateType.IdentityVault) {
      const v = this.#vaults.get(event.aggregate_id) ?? { id: event.aggregate_id, accessLog: [] };
      if (event.event_type === EventType.IdentityVerified) {
        v.sessionId = event.payload.session_id;
        v.passport = event.payload.passport; // 模拟加密静态数据：仅本投影持有
        v.visa = event.payload.visa ?? null;
        v.assertions = [];
      }
      if (event.event_type === EventType.PassportAccessGranted) {
        v.accessLog.push({ ...event.payload, granted: true, at: event.occurred_at });
      }
      if (event.event_type === EventType.PassportAccessed) {
        v.accessLog.push({ ...event.payload, at: event.occurred_at });
      }
      if (event.event_type === EventType.IdentityAssertionIssued) v.assertions.push(event.payload);
      this.#vaults.set(event.aggregate_id, v);
    }
  }

  openSession({ locale = "en", entryPoint = "provincial_portal" } = {}) {
    const sessionId = newId("ts");
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.SessionOpened,
        aggregate_type: AggregateType.TravelerSession,
        aggregate_id: sessionId,
        occurred_at: this.#clock.now(),
        version: 1,
        summary: "旅客在统一入口开启会话",
        correlation_id: sessionId,
        payload: { locale, entry_point: entryPoint },
      },
      0,
    );
    return this.#sessions.get(sessionId);
  }

  getSession(sessionId) {
    const s = this.#sessions.get(sessionId);
    if (!s) fail("SESSION_NOT_FOUND", `会话不存在：${sessionId}`);
    return s;
  }

  /**
   * 核验护照：原件只进入 vault，会话侧只记录 vault 编号与“已核验”结论。
   * passport 字段示例：full_name/passport_number/nationality/date_of_birth/sex/
   * passport_expiry/visa_type/visa_valid_until。
   */
  verifyPassport(sessionId, passport, visa) {
    const session = this.getSession(sessionId);
    if (session.verified) fail("IDENTITY_ALREADY_VERIFIED", "会话已完成身份核验");
    for (const field of ["full_name", "passport_number", "nationality"]) {
      if (!passport?.[field]) fail("PASSPORT_INCOMPLETE", `护照缺少字段：${field}`);
    }
    const vaultId = newId("vault");
    const version = this.#store.versionOf(AggregateType.IdentityVault, vaultId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.IdentityVerified,
        aggregate_type: AggregateType.IdentityVault,
        aggregate_id: vaultId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: "护照原件进入隔离 vault，签证资格结论同步生成",
        correlation_id: sessionId,
        payload: {
          session_id: sessionId,
          passport,
          visa: visa ?? null,
          qualification: this.#qualification(passport, visa),
        },
      },
      version,
    );
    const sVersion = this.#store.versionOf(AggregateType.TravelerSession, sessionId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.IdentityVerified,
        aggregate_type: AggregateType.TravelerSession,
        aggregate_id: sessionId,
        occurred_at: this.#clock.now(),
        version: sVersion + 1,
        summary: "身份核验通过",
        correlation_id: sessionId,
        payload: { vault_id: vaultId },
      },
      sVersion,
    );
    return { vaultId, qualification: this.qualificationOf(vaultId) };
  }

  #qualification(passport, visa) {
    const now = this.#clock.epochMs();
    const visaValid = Boolean(
      visa?.type && Date.parse(visa.validUntil) > now,
    );
    const adult = passport.date_of_birth
      ? now - Date.parse(passport.date_of_birth) >= 18 * 365.25 * 24 * 3600 * 1000
      : null;
    return {
      nationality: passport.nationality,
      visa_type: visa?.type ?? null,
      visa_valid: visaValid,
      adult,
    };
  }

  qualificationOf(vaultId) {
    const v = this.#requireVault(vaultId);
    return this.#qualification(v.passport, v.visa);
  }

  #requireVault(vaultId) {
    const v = this.#vaults.get(vaultId);
    if (!v) fail("VAULT_NOT_FOUND", `身份 vault 不存在：${vaultId}`);
    return v;
  }

  /**
   * 向服务方签发最小化身份断言：只包含该服务方白名单字段 + 资格结论。
   * 断言定向绑定（party_id + purpose），不能被转交他用。
   */
  issueAssertion({ vaultId, partyId, purpose, ttlMs = 30 * 60 * 1000 }) {
    const v = this.#requireVault(vaultId);
    const party = this.#registry.get(partyId);
    const fields = {};
    for (const field of party.identityPolicy.allowedFields) {
      if (field in v.passport) fields[field] = v.passport[field];
    }
    const assertionId = newId("assert");
    const expiresAt = new Date(this.#clock.epochMs() + ttlMs).toISOString();
    const version = this.#store.versionOf(AggregateType.IdentityVault, vaultId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.IdentityAssertionIssued,
        aggregate_type: AggregateType.IdentityVault,
        aggregate_id: vaultId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `向「${party.name}」签发用途为 ${purpose} 的最小身份断言`,
        correlation_id: v.sessionId,
        payload: {
          assertion_id: assertionId,
          party_id: partyId,
          purpose,
          fields_included: Object.keys(fields),
          qualification: this.qualificationOf(vaultId),
          expires_at: expiresAt,
        },
      },
      version,
    );
    // 交付给服务方的凭证内容：不含任何白名单外字段。
    return {
      assertion_id: assertionId,
      party_id: partyId,
      purpose,
      subject_session: v.sessionId,
      fields,
      qualification: this.qualificationOf(vaultId),
      expires_at: expiresAt,
    };
  }

  /** 授予有限护照原件访问权（如边检上报、退税开单），默认单次有效。 */
  grantPassportAccess({ vaultId, partyId, purpose, fields, singleUse = true }) {
    const v = this.#requireVault(vaultId);
    this.#registry.get(partyId);
    const grantId = newId("grant");
    const version = this.#store.versionOf(AggregateType.IdentityVault, vaultId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.PassportAccessGranted,
        aggregate_type: AggregateType.IdentityVault,
        aggregate_id: vaultId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `授予「${partyId}」护照原件访问：${purpose}`,
        correlation_id: v.sessionId,
        payload: { grant_id: grantId, party_id: partyId, purpose, fields, single_use: singleUse },
      },
      version,
    );
    return grantId;
  }

  /** 持 grant 读取护照原件；每次读取留审计痕，单次授权用后即焚。 */
  readPassport(vaultId, grantId) {
    const v = this.#requireVault(vaultId);
    const grant = v.accessLog.find((a) => a.grant_id === grantId && a.granted);
    if (!grant) fail("ACCESS_GRANT_NOT_FOUND", `授权不存在：${grantId}`);
    const uses = v.accessLog.filter((a) => a.grant_id === grantId && a.reason === "read");
    if (grant.single_use && uses.length >= 1) fail("ACCESS_GRANT_EXHAUSTED", "单次护照访问授权已使用");
    const version = this.#store.versionOf(AggregateType.IdentityVault, vaultId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.PassportAccessed,
        aggregate_type: AggregateType.IdentityVault,
        aggregate_id: vaultId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `「${grant.party_id}」依授权读取护照原件字段`,
        correlation_id: v.sessionId,
        payload: { grant_id: grantId, party_id: grant.party_id, reason: "read", fields: grant.fields },
      },
      version,
    );
    return Object.fromEntries(grant.fields.map((f) => [f, v.passport[f]]));
  }

  /** 运维视图：只返回访问审计，不回传护照内容。 */
  auditTrail(vaultId) {
    return this.#requireVault(vaultId).accessLog.map((a) => ({ ...a }));
  }
}
