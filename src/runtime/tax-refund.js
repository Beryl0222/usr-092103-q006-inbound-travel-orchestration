import { createHash } from "node:crypto";
import { AggregateType, EventType, RetentionClass } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 退税材料服务。
 *
 * 边界：
 *  - 退税窗口只需“退税资格”这一布尔断言，不接触护照原件；
 *  - 购物小票、退税单影像等材料收集进保险库密封件，事件中只有 sealed_ref；
 *  - 材料包一旦形成即纳入税务法定留档（legal_hold），
 *    游客之后撤回退税授权，只阻止后续新增/报送，已收集材料依法保留。
 */
export class TaxRefundService {
  constructor(store, clock, vault) {
    this.store = store;
    this.clock = clock;
    this.vault = vault;
    /** @type {Map<string, any>} */
    this.packs = new Map();
  }

  /**
   * 收集退税材料。
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} args.correlationId
   * @param {boolean} args.eligible 资格断言结果（由 AssertionService 签发后传入）
   * @param {boolean} args.authorized 当前退税授权是否有效
   * @param {Array<{name: string, content: any}>} args.documents 小票/退税单影像
   */
  collect({ sessionId, correlationId, eligible, authorized, documents }) {
    if (!authorized) {
      const err = new Error("退税授权无效或已撤回，不能新增材料");
      err.code = "NOT_AUTHORIZED";
      throw err;
    }
    if (!eligible) throw new Error("退税资格断言不通过");

    const packId = this.clock.id("tax");
    const sealedRef = this.vault.sealPassport(
      // 复用密封原语承载材料包（非身份文件同样只存密封件）。
      { documents: documents.map((d) => ({ name: d.name, sha: hashDoc(d.content) })), contents: documents },
      {
        sessionId,
        retentionClass: RetentionClass.TaxRefundRecord,
        legalHold: true, // 已收集即法定留档
        source: "tax_refund",
      },
    );

    const state = {
      pack_id: packId,
      session_id: sessionId,
      sealed_ref: sealedRef,
      document_count: documents.length,
      ready: documents.length > 0,
      legal_hold: true,
      collected_at: this.clock.now(),
      /** 后续用途开关：授权撤回后不可再报送，但材料留存。 */
      further_use_blocked: false,
    };
    this.packs.set(packId, state);

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.TaxFreeDocumentCollected,
        aggregateType: AggregateType.TaxRefundPack,
        aggregateId: packId,
        correlationId,
        provider: "tax_refund",
        summary: `退税材料已收集并密封（${documents.length} 份），纳入税务法定留档`,
        payload: {
          session_id: sessionId,
          sealed_ref: sealedRef,
          document_count: documents.length,
          retention_class: RetentionClass.TaxRefundRecord,
          retained: true,
          legal_hold: true,
        },
      }),
    );
    return { ...state };
  }

  /** 授权撤回联动：阻断后续报送，不动已留档材料。 */
  blockFurtherUse(packId) {
    const pack = this.packs.get(packId);
    if (!pack) return null;
    pack.further_use_blocked = true;
    return { ...pack };
  }

  /** 向海关/税务报送；授权撤回后被拒绝。 */
  submit(packId) {
    const pack = this.packs.get(packId);
    if (!pack) throw new Error("退税材料包不存在");
    if (pack.further_use_blocked) {
      const err = new Error("授权已撤回：仅阻断后续报送，已留档材料保留");
      err.code = "FURTHER_USE_BLOCKED";
      throw err;
    }
    pack.submitted = true;
    pack.submitted_at = this.clock.now();
    return { ...pack };
  }

  listBySession(sessionId) {
    return [...this.packs.values()].filter((p) => p.session_id === sessionId).map((p) => ({ ...p }));
  }
}

function hashDoc(content) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
