import { AggregateType, EventType } from "../domain.ts";
import { newId } from "../platform/ids.js";

/**
 * 数据留存域。
 *
 * “同一入口、各服务方留存规则不同”的执行点：
 * - 每类交付给服务方的数据在事件发生时登记为一条 holding（断言、入住资料、支付资料、翻译素材等）；
 * - sweep 按该服务方注册的 retentionPolicy.days 判定到期；
 * - 法定留档（LEGAL_RECORD_HELD）按 transaction_ref 精确保护已完成交易相关 holding 至 retain_until，
 *   授权撤回不会移除这些保护，游客撤回也不破坏法定留档；
 * - 菜单/过敏原翻译素材 complianceRetained：原图来源、置信度、更正链长期保留，不参与例行清理；
 * - 清理只删除“交付副本/工作数据”（模拟 data bin），事件审计流本身仅追加、永不删除，
 *   清理事实以 RETENTION_PURGED 记录在旅客会话聚合上。
 */
export class RetentionService {
  #store;
  #clock;
  #registry;
  #holdings = new Map();
  #holds = new Map(); // transaction_ref -> { party_id, retain_until }
  #dataBin = new Map(); // holding_id -> 交付数据副本（模拟）

  constructor({ store, clock, registry }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    store.subscribe((e) => this.#apply(e));
  }

  #apply(event) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case EventType.IdentityAssertionIssued:
        this.#register({
          partyId: p.party_id,
          sessionId: event.correlation_id,
          dataClass: "identity_assertion",
          ref: p.assertion_id,
          createdAt: event.occurred_at,
          data: { fields_included: p.fields_included, purpose: p.purpose },
        });
        break;
      case EventType.VoucherIssued:
        this.#register({
          partyId: p.party_id,
          sessionId: event.correlation_id,
          dataClass: "reservation_guest_data",
          transactionRef: event.aggregate_id,
          ref: event.aggregate_id,
          createdAt: event.occurred_at,
          data: { qr_code: p.qr_code },
        });
        break;
      case EventType.PaymentInitiated:
        this.#register({
          partyId: p.party_id,
          sessionId: event.correlation_id,
          dataClass: "payment_record",
          transactionRef: event.aggregate_id,
          ref: event.aggregate_id,
          createdAt: event.occurred_at,
          data: { amount: p.amount, purpose: p.purpose },
        });
        break;
      case EventType.TranslationSubmitted:
        this.#register({
          partyId: p.party_id,
          sessionId: event.correlation_id,
          dataClass: p.context === "menu" ? "menu_translation_provenance" : "translation_source",
          ref: event.aggregate_id,
          createdAt: event.occurred_at,
          // 过敏原安全溯源：原图来源/哈希必须长期可查。
          complianceRetained: p.context === "menu",
          data: { source: p.source, target_lang: p.target_lang },
        });
        break;
      case EventType.TaxRefundDocumentPrepared:
        this.#register({
          partyId: p.party_id,
          sessionId: event.correlation_id,
          dataClass: "tax_refund_record",
          transactionRef: event.aggregate_id,
          ref: event.aggregate_id,
          createdAt: event.occurred_at,
          data: { documents: p.documents },
        });
        if (p.legal_hold && p.retain_until) {
          this.#holds.set(event.aggregate_id, { party_id: p.party_id, retain_until: p.retain_until });
        }
        break;
      case EventType.LegalRecordHeld:
        this.#holds.set(p.transaction_ref, { party_id: p.party_id, retain_until: p.retain_until });
        break;
      case EventType.RetentionPurged:
        // 重放事件流时恢复“已清理”状态。
        for (const id of p.holding_ids) {
          this.#dataBin.delete(id);
          const h = this.#holdings.get(id);
          if (h) h.purgedAt = event.occurred_at;
        }
        break;
      default:
    }
  }

  #register({ partyId, sessionId, dataClass, transactionRef = null, ref, createdAt, data, complianceRetained = false }) {
    if (!partyId) return; // 支付事件的 party_id 在支付聚合上（由 initiate 记录），无 party 时跳过自动登记
    const id = newId("hold");
    this.#holdings.set(id, {
      id,
      partyId,
      sessionId,
      dataClass,
      transactionRef,
      ref,
      createdAt: Date.parse(createdAt),
      complianceRetained,
    });
    this.#dataBin.set(id, data);
  }

  /** 某条 holding 是否处于法定留档保护期。 */
  #legalProtection(holding) {
    if (!holding.transactionRef) return null;
    const hold = this.#holds.get(holding.transactionRef);
    if (!hold || hold.party_id !== holding.partyId) return null;
    if (Date.parse(hold.retain_until) > this.#clock.epochMs()) return hold.retain_until;
    return null; // 留档期满，恢复按普通留存处理
  }

  listHoldings(sessionId) {
    return [...this.#holdings.values()]
      .filter((h) => h.sessionId === sessionId)
      .map((h) => ({
        ...h,
        data_present: this.#dataBin.has(h.id),
        legal_protected_until: this.#legalProtection(h),
      }));
  }

  /**
   * 执行清理扫描。返回被清理的 holding。
   * 清理顺序：合规留存 → 法定留档保护 → 服务方留存天数。
   */
  sweep() {
    const purged = [];
    const bySession = new Map();
    for (const h of this.#holdings.values()) {
      if (h.purgedAt) continue;
      if (h.complianceRetained) continue;
      const protectedUntil = this.#legalProtection(h);
      if (protectedUntil) continue;
      const days = this.#registry.get(h.partyId).retentionPolicy.days;
      const ageMs = this.#clock.epochMs() - h.createdAt;
      if (ageMs <= days * 24 * 3600 * 1000) continue;

      this.#dataBin.delete(h.id);
      h.purgedAt = this.#clock.now();
      purged.push(h);
      if (!bySession.has(h.sessionId)) bySession.set(h.sessionId, []);
      bySession.get(h.sessionId).push(h);
    }
    for (const [sessionId, holdings] of bySession) {
      const version = this.#store.versionOf(AggregateType.TravelerSession, sessionId);
      this.#store.append(
        {
          event_id: newId("evt"),
          event_type: EventType.RetentionPurged,
          aggregate_type: AggregateType.TravelerSession,
          aggregate_id: sessionId,
          occurred_at: this.#clock.now(),
          version: version + 1,
          summary: `按服务方留存策略清理 ${holdings.length} 项到期数据（法定留档与过敏原溯源素材除外）`,
          correlation_id: sessionId,
          payload: {
            holding_ids: holdings.map((h) => h.id),
            items: holdings.map((h) => ({
              holding_id: h.id,
              party_id: h.partyId,
              data_class: h.dataClass,
            })),
          },
        },
        version,
      );
    }
    return purged.map((h) => ({
      holding_id: h.id,
      party_id: h.partyId,
      data_class: h.dataClass,
      session_id: h.sessionId,
    }));
  }
}
