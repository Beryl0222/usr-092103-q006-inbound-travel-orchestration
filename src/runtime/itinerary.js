import { createHash } from "node:crypto";
import { AggregateType, EventType } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 行程版本服务。
 *
 * 版本语义：
 *  - 任何变化（客流、价格、营业时间）都先产生一条“提案”版本（ITINERARY_PROPOSED），
 *    游客确认后才成为“确认”版本（ITINERARY_CONFIRMED）。
 *  - 已确认的交通与住宿是锚点（anchor）：后续提案必须原样保留，
 *    平台只能“新增项目”或“并列提供替代选项”，不能静默替换或删除锚点；
 *    试图改动锚点的提案会被拒绝（ANCHOR_PROTECTED），并要求游客显式换订。
 *  - 每次版本化修改都落 ITINERARY_UPDATED，附 change_note 说明谁改了什么。
 */
export class ItineraryService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    /** @type {Map<string, any>} revision_id -> state */
    this.revisions = new Map();
    /** session -> revision_id[] 顺序 */
    this.bySession = new Map();
  }

  /**
   * 提出新版本。
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} args.correlationId
   * @param {any[]} args.items 提案条目
   * @param {string} args.changeNote 变化说明（客流/价格/营业时间等）
   */
  propose({ sessionId, correlationId, items, changeNote }) {
    const confirmed = this.latestConfirmed(sessionId);
    if (confirmed) {
      const violation = this.#anchorViolation(confirmed.items, items);
      if (violation) {
        const err = new Error(`提案触碰已确认锚点：${violation}。交通/住宿须由游客显式换订，不得静默替换`);
        err.code = "ANCHOR_PROTECTED";
        err.violation = violation;
        throw err;
      }
    }
    return this.#save({
      sessionId,
      correlationId,
      items: items.map((it) => ({ ...it, anchor: it.anchor ?? false })),
      kind: "proposal",
      changeNote,
      type: EventType.ItineraryProposed,
      summary: `形成新行程提案（${changeNote}）`,
    });
  }

  /**
   * 游客确认提案。其中已绑定确认预订的交通/住宿条目被冻结为锚点。
   * @param {(id: string) => any} [reservationLookup] 预订状态查询，确认后冻结锚点
   */
  confirm(revisionId, correlationId, reservationLookup) {
    const rev = this.revisions.get(revisionId);
    if (!rev) throw new Error("行程版本不存在");
    if (rev.kind === "confirmation") return this.#external(rev);

    for (const it of rev.items) {
      if (it.type === "transport" || it.type === "lodging") {
        const r = it.reservation_id && reservationLookup ? reservationLookup(it.reservation_id) : null;
        // 有确认预订的交通/住宿立即成为不可静默替换的锚点。
        if (r && r.status === "confirmed") it.anchor = true;
      }
    }
    rev.kind = "confirmation";
    rev.confirmed_at = this.clock.now();
    rev.anchors_frozen = rev.items.some((i) => i.anchor);

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.ItineraryConfirmed,
        aggregateType: AggregateType.ItineraryRevision,
        aggregateId: rev.revision_id,
        correlationId,
        provider: "orchestrator",
        summary: `游客确认行程 v${rev.revision_no}，锚点${rev.anchors_frozen ? "已冻结" : "：无"}`,
        payload: {
          session_id: rev.session_id,
          revision_no: rev.revision_no,
          anchors_frozen: rev.anchors_frozen,
        },
      }),
    );

    // 确认即一次正式更新，补一条 ITINERARY_UPDATED 供既有订阅方感知。
    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.ItineraryUpdated,
        aggregateType: AggregateType.ItineraryRevision,
        aggregateId: rev.revision_id,
        correlationId,
        provider: "orchestrator",
        summary: `行程更新至 v${rev.revision_no}（已确认）`,
        payload: { session_id: rev.session_id, revision_no: rev.revision_no, anchors_frozen: rev.anchors_frozen },
      }),
    );
    return this.#external(rev);
  }

  latest(sessionId) {
    const ids = this.bySession.get(sessionId) ?? [];
    return ids.length ? this.#external(this.revisions.get(ids[ids.length - 1])) : null;
  }

  latestConfirmed(sessionId) {
    const ids = this.bySession.get(sessionId) ?? [];
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const rev = this.revisions.get(ids[i]);
      if (rev.kind === "confirmation") return this.#external(rev);
    }
    return null;
  }

  list(sessionId) {
    return (this.bySession.get(sessionId) ?? []).map((id) => this.#external(this.revisions.get(id)));
  }

  /**
   * 版本差异视图：游客可看清每个条目的去留与变化，锚点单独标注。
   */
  diff(sessionId) {
    const revs = this.list(sessionId);
    if (revs.length < 2) return { base: null, changes: [] };
    const prev = revs[revs.length - 2];
    const next = revs[revs.length - 1];
    const prevById = new Map(prev.items.map((i) => [i.item_id, i]));
    const nextById = new Map(next.items.map((i) => [i.item_id, i]));
    const changes = [];
    for (const [id, before] of prevById) {
      const after = nextById.get(id);
      if (!after) changes.push({ kind: "removed", item: before, anchor: before.anchor });
      else if (fingerprint(before) !== fingerprint(after)) {
        changes.push({ kind: "changed", before, after, anchor: Boolean(before.anchor || after.anchor) });
      }
    }
    for (const [id, after] of nextById) {
      if (!prevById.has(id)) changes.push({ kind: "added", item: after, anchor: after.anchor });
    }
    return { base: prev.revision_no, target: next.revision_no, note: next.change_note, changes };
  }

  /**
   * 检查提案是否破坏锚点：
   * - 锚点条目不得缺失；
   * - 锚点条目的资源/预订/核心细节指纹必须一致（价格备注等非核心字段可在替代项中呈现）。
   * 返回首个违规描述；无违规返回 null。
   */
  #anchorViolation(anchoredItems, proposedItems) {
    const byId = new Map(proposedItems.map((i) => [i.item_id, i]));
    for (const anchor of anchoredItems.filter((i) => i.anchor)) {
      const p = byId.get(anchor.item_id);
      if (!p) return `锚点条目 ${anchor.item_id}（${anchor.type}）被删除或替换`;
      if (p.reservation_id !== anchor.reservation_id) {
        return `锚点条目 ${anchor.item_id} 的预订被替换（${anchor.reservation_id} -> ${p.reservation_id}）`;
      }
      if (fingerprint(p) !== fingerprint(anchor)) {
        return `锚点条目 ${anchor.item_id} 的核心安排被改动`;
      }
    }
    return null;
  }

  #save({ sessionId, correlationId, items, kind, changeNote, type, summary }) {
    const ids = this.bySession.get(sessionId) ?? [];
    const prev = ids.length ? this.revisions.get(ids[ids.length - 1]) : null;
    const revisionNo = prev ? prev.revision_no + 1 : 1;
    const revisionId = this.clock.id("itin");
    const state = {
      revision_id: revisionId,
      session_id: sessionId,
      revision_no: revisionNo,
      kind,
      items,
      anchors_frozen: false,
      supersedes_revision: prev?.revision_no,
      change_note: changeNote,
      created_at: this.clock.now(),
    };
    this.revisions.set(revisionId, state);
    ids.push(revisionId);
    this.bySession.set(sessionId, ids);

    this.store.append(
      makeEvent(this.store, this.clock, {
        type,
        aggregateType: AggregateType.ItineraryRevision,
        aggregateId: revisionId,
        correlationId,
        provider: "orchestrator",
        summary,
        payload: {
          session_id: sessionId,
          revision_no: revisionNo,
          anchors_frozen: false,
        },
      }),
    );
    return this.#external(state);
  }

  #external(rev) {
    return { ...rev, items: rev.items.map((i) => ({ ...i })) };
  }
}

/** 条目的核心安排指纹：参与锚点比对。 */
function fingerprint(item) {
  const core = {
    item_id: item.item_id,
    type: item.type,
    reservation_id: item.reservation_id ?? null,
    provider: item.provider,
    detail: item.detail ?? {},
  };
  return createHash("sha256").update(JSON.stringify(core)).digest("hex");
}
