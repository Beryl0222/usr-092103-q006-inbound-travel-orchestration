import { AggregateType, EventType } from "../domain.ts";
import { fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

/**
 * 退税域。
 *
 * 材料组装原则：
 * - 退税开单确需护照原件：通过一次性 grant 经 vault 读取，读取动作留 PASSPORT_ACCESSED 审计；
 *   材料事件只保存材料清单与 vault/grant 引用，不复制护照原件到退税聚合；
 * - 必须存在有效且覆盖 tax_refund 用途的授权；撤回后不能再准备新材料，
 *   但已生成案件的法定留档（retain_until）不受影响；
 * - 留存期取自退税服务方自己的留存策略（异构规则），法定留档默认开启。
 */
export class TaxRefundService {
  #store;
  #clock;
  #registry;
  #identity;
  #authorization;
  #cases = new Map();

  constructor({ store, clock, registry, identity, authorization }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    this.#identity = identity;
    this.#authorization = authorization;
    store.subscribe((e) => this.#apply(e));
  }

  #apply(event) {
    if (event.aggregate_type !== AggregateType.TaxRefundCase) return;
    if (event.event_type === EventType.TaxRefundDocumentPrepared) {
      this.#cases.set(event.aggregate_id, {
        id: event.aggregate_id,
        ...structuredClone(event.payload),
        preparedAt: event.occurred_at,
      });
    }
  }

  /**
   * 准备退税材料包。
   * purchases：[{ receipt_ref, payment_id?, merchant_party_id, amount: {amount,currency}, date }]
   */
  prepare({ sessionId, vaultId, authId, partyId, purchases }) {
    const auth = this.#authorization.assertUsable(authId, "tax_refund");
    if (auth.vaultId !== vaultId || auth.sessionId !== sessionId)
      fail("AUTHORIZATION_MISMATCH", "授权与会话/身份 vault 不匹配");
    const party = this.#registry.get(partyId);
    if (party.kind !== "tax_refund") fail("WRONG_PARTY_KIND", `退税材料只能由退税服务方出具：${partyId}`);
    if (!Array.isArray(purchases) || purchases.length === 0)
      fail("NO_PURCHASES", "退税材料至少包含一笔购物凭证");

    // 经一次性授权读取退税所需的最小原件字段集合（以服务方白名单为上限）。
    const fields = ["full_name", "passport_number", "nationality"].filter((f) =>
      party.identityPolicy.allowedFields.has(f),
    );
    const grantId = this.#identity.grantPassportAccess({
      vaultId,
      partyId,
      purpose: "tax_refund_document",
      fields,
    });
    const passportExtract = this.#identity.readPassport(vaultId, grantId);
    const qualification = this.#identity.qualificationOf(vaultId);

    const policy = party.retentionPolicy;
    const retainUntil = new Date(
      this.#clock.epochMs() + policy.days * 24 * 3600 * 1000,
    ).toISOString();

    const caseId = newId("tax");
    const total = purchases.reduce((sum, p) => sum + Number(p.amount?.amount ?? 0), 0);
    const currency = purchases[0].amount?.currency ?? "CNY";
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.TaxRefundDocumentPrepared,
        aggregate_type: AggregateType.TaxRefundCase,
        aggregate_id: caseId,
        occurred_at: this.#clock.now(),
        version: 1,
        summary: `退税材料包就绪：${purchases.length} 笔购物凭证，法定留档至 ${retainUntil}`,
        correlation_id: sessionId,
        payload: {
          session_id: sessionId,
          vault_id: vaultId,
          auth_id: authId,
          party_id: partyId,
          grant_id: grantId,
          purchases: purchases.map((p) => ({
            receipt_ref: p.receipt_ref,
            payment_id: p.payment_id ?? null,
            merchant_party_id: p.merchant_party_id,
            amount: p.amount,
            date: p.date,
          })),
          total_amount: { amount: Number(total.toFixed(2)), currency },
          // 材料清单：清单在此，原件仍在 vault；退税单上的姓名/证号快照字段名留痕。
          documents: [
            { type: "tax_refund_form", fields_from_passport: Object.keys(passportExtract) },
            { type: "passport_extract_ref", grant_id: grantId },
            { type: "purchase_receipts", count: purchases.length },
            ...(qualification.visa_valid ? [{ type: "visa_qualification", visa_valid: true }] : []),
          ],
          legal_hold: policy.legalHold,
          retain_until: policy.legalHold ? retainUntil : null,
        },
      },
      0,
    );
    return this.get(caseId);
  }

  get(caseId) {
    const c = this.#cases.get(caseId);
    if (!c) fail("TAX_CASE_NOT_FOUND", `退税案件不存在：${caseId}`);
    return structuredClone(c);
  }

  listBySession(sessionId) {
    return [...this.#cases.values()].filter((c) => c.session_id === sessionId).map((c) => structuredClone(c));
  }
}
