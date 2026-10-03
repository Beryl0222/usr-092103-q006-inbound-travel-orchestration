import { AggregateType, EventType } from "../domain.ts";
import { fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

const CONFIRMED_KINDS = new Set(["lodging", "transport"]);

/**
 * 行程版本域。
 *
 * 版本语义（对应“客流、价格、营业时间变化可以提出新方案，但不能静默替换”）：
 * - 每次变化都产生一个新的 proposed 修订版（ITINERARY_PROPOSED），
 *   其中逐行标注 added/removed/price_changed/time_changed；
 *   涉及已确认交通/住宿的变化标 requires_confirmation，并在 payload 中说明原因；
 * - 当前已确认版本在游客明确接受前保持有效，任何已确认条目都不会被后台改动；
 * - 游客拒绝 → ITINERARY_REJECTED，提案作废，已确认版本不动；
 * - 游客接受 → ITINERARY_UPDATED，新版本成为 confirmed，并给出 superseded 条目列表，
 *   供编排层触发换订/凭证作废。
 */
export class ItineraryService {
  #store;
  #clock;
  // itineraryId -> { current: revision, revisions: Map<version, revision> }
  #itineraries = new Map();

  constructor({ store, clock }) {
    this.#store = store;
    this.#clock = clock;
    store.subscribe((e) => this.#apply(e));
  }

  #apply(event) {
    if (event.aggregate_type !== AggregateType.ItineraryRevision) return;
    const it =
      this.#itineraries.get(event.aggregate_id) ??
      { id: event.aggregate_id, revisions: new Map(), current: null, pending: null };
    const p = event.payload;
    if (event.event_type === EventType.ItineraryProposed) {
      const rev = {
        version: p.version, // 业务修订版号（payload），与事件流版本号解耦
        status: "proposed",
        items: structuredClone(p.items),
        changes: structuredClone(p.changes),
        reason: p.reason,
        requiresConfirmation: p.requires_confirmation,
        proposedAt: event.occurred_at,
      };
      it.revisions.set(p.version, rev);
      it.pending = rev;
    }
    if (event.event_type === EventType.ItineraryRejected) {
      const rev = it.revisions.get(p.version);
      if (rev) rev.status = "rejected";
      it.pending = null;
    }
    if (event.event_type === EventType.ItineraryUpdated) {
      const rev = it.revisions.get(p.version);
      rev.status = "confirmed";
      // 已确认条目打标：下一版 diff 据此识别“涉及已确认交通/住宿”的变化。
      for (const item of rev.items) item.status = "confirmed";
      rev.confirmedAt = event.occurred_at;
      rev.superseded = p.superseded;
      it.current = rev;
      it.pending = null;
    }
    this.#itineraries.set(event.aggregate_id, it);
  }

  /** 首版方案（全部条目标记 added）。 */
  proposeInitial(sessionId, items, reason = "初始行程方案") {
    for (const id of this.#itineraries.keys()) {
      if (this.#itineraries.get(id).sessionId === sessionId)
        fail("ITINERARY_EXISTS", `会话已有行程：${id}，请使用 proposeChange`);
    }
    const itineraryId = newId("itin");
    this.#itineraries.set(itineraryId, {
      id: itineraryId,
      sessionId,
      revisions: new Map(),
      current: null,
      pending: null,
    });
    return this.#propose(itineraryId, sessionId, items, reason);
  }

  /** 因客流/价格/营业时间等外部变化提出新方案。 */
  proposeChange(itineraryId, items, reason) {
    const it = this.#require(itineraryId);
    if (it.pending) fail("PROPOSAL_PENDING", "已有待确认方案，请先接受或拒绝");
    return this.#propose(itineraryId, it.sessionId, items, reason);
  }

  #propose(itineraryId, sessionId, items, reason) {
    const it = this.#itineraries.get(itineraryId);
    if (!Array.isArray(items) || items.length === 0) fail("EMPTY_ITINERARY", "行程至少包含一个条目");
    const version = it.revisions.size + 1;
    const stored = items.map((i) => ({ ...i, item_id: i.item_id ?? newId("item") }));
    const oldItems = it.current ? it.current.items : [];
    const changes = diffItems(oldItems, stored);
    const touchesConfirmed = changes
      .filter((c) => c.kind !== "added")
      .some((c) => CONFIRMED_KINDS.has(c.kind_of_item) && c.was_confirmed);
    const currentVersion = this.#store.versionOf(AggregateType.ItineraryRevision, itineraryId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.ItineraryProposed,
        aggregate_type: AggregateType.ItineraryRevision,
        aggregate_id: itineraryId,
        occurred_at: this.#clock.now(),
        version: currentVersion + 1,
        summary: `提出行程第 ${version} 版：${reason}`,
        correlation_id: sessionId,
        payload: {
          version,
          items: stored,
          changes,
          reason,
          requires_confirmation: touchesConfirmed,
          based_on_version: it.current?.version ?? 0,
        },
      },
      currentVersion,
    );
    return { itineraryId, proposal: this.#itineraries.get(itineraryId).pending, changes };
  }

  reject(itineraryId, reason = "游客拒绝新方案") {
    const it = this.#require(itineraryId);
    if (!it.pending) fail("NO_PENDING_PROPOSAL", "没有待确认方案");
    const version = this.#store.versionOf(AggregateType.ItineraryRevision, itineraryId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.ItineraryRejected,
        aggregate_type: AggregateType.ItineraryRevision,
        aggregate_id: itineraryId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: "游客拒绝新方案，维持已确认行程",
        correlation_id: it.sessionId,
        payload: { version: it.pending.version, reason },
      },
      version,
    );
    return it.current;
  }

  /** 游客明确接受提案；返回被替换的已确认条目，供编排层换订。 */
  accept(itineraryId) {
    const it = this.#require(itineraryId);
    if (!it.pending) fail("NO_PENDING_PROPOSAL", "没有待确认方案");
    const proposal = it.pending;
    const superseded = proposal.changes
      .filter((c) => c.kind !== "added" && c.was_confirmed)
      .map((c) => ({
        item_id: c.item_id,
        kind: c.kind_of_item,
        party_id: c.party_id,
        reservation_ref: c.reservation_ref ?? null,
        change: c.kind,
      }));
    const version = this.#store.versionOf(AggregateType.ItineraryRevision, itineraryId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.ItineraryUpdated,
        aggregate_type: AggregateType.ItineraryRevision,
        aggregate_id: itineraryId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `游客接受第 ${proposal.version} 版行程，替换已确认条目 ${superseded.length} 项`,
        correlation_id: it.sessionId,
        payload: {
          version: proposal.version,
          items: structuredClone(proposal.items),
          superseded,
          change_reason: proposal.reason,
        },
      },
      version,
    );
    return { current: it.current, superseded };
  }

  #require(itineraryId) {
    const it = this.#itineraries.get(itineraryId);
    if (!it) fail("ITINERARY_NOT_FOUND", `行程不存在：${itineraryId}`);
    return it;
  }

  get(itineraryId) {
    const it = this.#require(itineraryId);
    return {
      id: it.id,
      sessionId: it.sessionId,
      current: it.current ? structuredClone(it.current) : null,
      pending: it.pending ? structuredClone(it.pending) : null,
      revisionCount: it.revisions.size,
    };
  }
}

/**
 * 逐行对比新旧行程。item_id 稳定时识别同一服务的变化（价格/时间/商户）；
 * 已确认条目的变化都带 was_confirmed=true，供提案标记需游客确认。
 */
function diffItems(oldItems, newItems) {
  const changes = [];
  const oldById = new Map(oldItems.map((i) => [i.item_id, i]));
  const newById = new Map(newItems.map((i) => [i.item_id, i]));

  for (const item of newItems) {
    const before = oldById.get(item.item_id);
    if (!before) {
      changes.push({ item_id: item.item_id, kind: "added", kind_of_item: item.kind, party_id: item.party_id });
      continue;
    }
    const detail = {
      item_id: item.item_id,
      kind_of_item: item.kind,
      party_id: item.party_id,
      was_confirmed: before.status === "confirmed",
      reservation_ref: before.reservation_ref ?? null,
    };
    if (before.party_id !== item.party_id)
      changes.push({ ...detail, kind: "merchant_changed", from: before.party_id, to: item.party_id });
    if (Number(before.price?.amount) !== Number(item.price?.amount) || before.price?.currency !== item.price?.currency)
      changes.push({
        ...detail,
        kind: "price_changed",
        from: before.price,
        to: item.price,
      });
    if (before.start !== item.start || before.end !== item.end)
      changes.push({ ...detail, kind: "time_changed", from: { start: before.start, end: before.end }, to: { start: item.start, end: item.end } });
  }
  for (const before of oldItems) {
    if (!newById.has(before.item_id)) {
      changes.push({
        item_id: before.item_id,
        kind: "removed",
        kind_of_item: before.kind,
        party_id: before.party_id,
        was_confirmed: before.status === "confirmed",
        reservation_ref: before.reservation_ref ?? null,
      });
    }
  }
  return changes;
}
