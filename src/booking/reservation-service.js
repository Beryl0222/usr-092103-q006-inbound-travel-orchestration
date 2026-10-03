import { AggregateType, EventType } from "../domain.ts";
import { fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

/**
 * 预订占用与凭证域。
 *
 * 解决的问题：
 * - 占位排他：按（服务方, 资源, 日期）登记容量，requested 报价即占位；
 *   重复请求带同一 idempotency_key 时回放首次结果，不会第二次占位。
 * - 报价有时效：offer_expires_at 到期由 sweepExpired 释放容量（RESERVATION_OFFER_EXPIRED）。
 * - 凭证生命周期：确认后签发二维码 VOUCHER_ISSUED；换订/取消先撤销旧码 VOUCHER_REVOKED，
 *   旧二维码在任何核验点立即失效，不会出现“换了酒店旧码还能用”。
 * - 回调幂等：服务方确认/拒绝回调按 callback_id 去重，重复回调不重复占位、不重复发码。
 */
export class ReservationService {
  #store;
  #clock;
  #registry;
  #idempotency;
  #reservations = new Map();
  #capacity = new Map(); // key -> { total, held }

  constructor({ store, clock, registry, idempotency }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    this.#idempotency = idempotency;
    store.subscribe((e) => this.#apply(e));
  }

  #capKey(partyId, resourceId, date) {
    return `${partyId}|${resourceId}|${date}`;
  }

  /** 登记某服务方某资源某日的可售容量（演示用库存入口）。 */
  addCapacity(partyId, resourceId, date, total) {
    const key = this.#capKey(partyId, resourceId, date);
    const cur = this.#capacity.get(key) ?? { total: 0, held: 0 };
    cur.total += total;
    this.#capacity.set(key, cur);
  }

  occupancy(partyId, resourceId, date) {
    const c = this.#capacity.get(this.#capKey(partyId, resourceId, date));
    return c ? { total: c.total, held: c.held, available: c.total - c.held } : null;
  }

  #apply(event) {
    if (event.aggregate_type !== AggregateType.Reservation) return;
    const p = event.payload;
    const r =
      this.#reservations.get(event.aggregate_id) ??
      { id: event.aggregate_id, callbacks: {} };
    switch (event.event_type) {
      case EventType.ReservationRequested:
        r.sessionId = p.session_id;
        r.partyId = p.party_id;
        r.resourceId = p.resource_id;
        r.date = p.date;
        r.quantity = p.quantity;
        r.status = "requested";
        r.offerExpiresAt = p.offer_expires_at;
        r.requestedAt = event.occurred_at;
        break;
      case EventType.ReservationConfirmed:
        r.status = "confirmed";
        r.ref = p.reservation_ref;
        r.confirmedAt = event.occurred_at;
        if (p.callback_id) r.callbacks[p.callback_id] = "succeeded";
        break;
      case EventType.ReservationRejected:
        r.status = "rejected";
        r.rejectReason = p.reason;
        if (p.callback_id) r.callbacks[p.callback_id] = "rejected";
        break;
      case EventType.ReservationOfferExpired:
        r.status = "expired";
        break;
      case EventType.ReservationCancelled:
        r.status = "cancelled";
        r.cancelReason = p.reason;
        break;
      case EventType.VoucherIssued:
        r.voucher = { code: p.qr_code, status: "active", issuedAt: event.occurred_at };
        break;
      case EventType.VoucherRevoked:
        if (r.voucher) r.voucher.status = "revoked";
        r.voucherRevokedReason = p.reason;
        break;
      default:
    }
    this.#reservations.set(event.aggregate_id, r);
  }

  /** 发起预订（占用容量）。同一 idempotencyKey 的重复调用回放首次结果。 */
  request({ sessionId, partyId, resourceId, date, quantity = 1, idempotencyKey, offerTtlMs = 900_000 }) {
    this.#registry.get(partyId);
    return this.#idempotency.once(partyId, idempotencyKey, () => {
      const key = this.#capKey(partyId, resourceId, date);
      const cap = this.#capacity.get(key);
      if (!cap || cap.total - cap.held < quantity) {
        fail("NO_CAPACITY", `资源已满：${key}`, { available: cap ? cap.total - cap.held : 0 });
      }
      const id = newId("res");
      const offerExpiresAt = new Date(this.#clock.epochMs() + offerTtlMs).toISOString();
      this.#store.append(
        {
          event_id: newId("evt"),
          event_type: EventType.ReservationRequested,
          aggregate_type: AggregateType.Reservation,
          aggregate_id: id,
          occurred_at: this.#clock.now(),
          version: 1,
          summary: `向「${partyId}」请求预订 ${resourceId}（${date}），占用 ${quantity} 个名额`,
          correlation_id: sessionId,
          payload: {
            session_id: sessionId,
            party_id: partyId,
            resource_id: resourceId,
            date,
            quantity,
            offer_expires_at: offerExpiresAt,
          },
        },
        0,
      );
      cap.held += quantity; // 占位仅在事件成功落库后生效
      return this.get(id);
    });
  }

  /**
   * 服务方异步确认/拒绝回调。callback_id 去重：
   * 同一回调无论到达多少次，只产生一次确认/拒绝与一张二维码。
   */
  confirmCallback(partyId, { callbackId, reservationId, accepted, reservationRef, reason }) {
    const r = this.get(reservationId);
    if (r.partyId !== partyId) fail("PARTY_MISMATCH", "回调服务方与预订服务方不一致");
    // 终态短路：即使服务方换了 callback_id 重发，也不再产生第二张二维码或第二次拒绝。
    if (r.status === "confirmed") return r;
    if (["rejected", "expired", "cancelled"].includes(r.status))
      fail("RESERVATION_TERMINAL", `预订已是终态 ${r.status}，回调不再生效`, { status: r.status });
    return this.#idempotency.once(partyId, callbackId, () => {
      const baseVersion = this.#store.versionOf(AggregateType.Reservation, reservationId);
      if (accepted) {
        this.#store.append(
          {
            event_id: newId("evt"),
            event_type: EventType.ReservationConfirmed,
            aggregate_type: AggregateType.Reservation,
            aggregate_id: reservationId,
            occurred_at: this.#clock.now(),
            version: baseVersion + 1,
            summary: `「${partyId}」确认预订 ${reservationRef}`,
            correlation_id: r.sessionId,
            causation_id: callbackId,
            payload: { callback_id: callbackId, reservation_ref: reservationRef ?? newId("ref") },
          },
          baseVersion,
        );
        const v2 = baseVersion + 1;
        const qrCode = newId("qr");
        this.#store.append(
          {
            event_id: newId("evt"),
            event_type: EventType.VoucherIssued,
            aggregate_type: AggregateType.Reservation,
            aggregate_id: reservationId,
            occurred_at: this.#clock.now(),
            version: v2 + 1,
            summary: "签发入住/乘车二维码凭证",
            correlation_id: r.sessionId,
            payload: { qr_code: qrCode, party_id: partyId, reservation_ref: reservationRef },
          },
          v2,
        );
      } else {
        this.#releaseCapacity(reservationId);
        this.#store.append(
          {
            event_id: newId("evt"),
            event_type: EventType.ReservationRejected,
            aggregate_type: AggregateType.Reservation,
            aggregate_id: reservationId,
            occurred_at: this.#clock.now(),
            version: baseVersion + 1,
            summary: `「${partyId}」拒绝预订：${reason ?? "未说明"}`,
            correlation_id: r.sessionId,
            causation_id: callbackId,
            payload: { callback_id: callbackId, reason: reason ?? null },
          },
          baseVersion,
        );
      }
      return this.get(reservationId);
    });
  }

  /** 取消（含游客换订触发）：释放容量并让旧二维码立即失效。 */
  cancel(reservationId, reason = "游客换订/取消") {
    const r = this.get(reservationId);
    if (r.status === "cancelled") return r;
    const version = this.#store.versionOf(AggregateType.Reservation, reservationId);
    const events = [];
    if (r.status === "requested" || r.status === "confirmed") {
      this.#releaseCapacity(reservationId);
      events.push({
        event_type: EventType.ReservationCancelled,
        payload: { reason },
      });
    }
    if (r.voucher?.status === "active") {
      events.push({ event_type: EventType.VoucherRevoked, payload: { reason, old_qr_code: r.voucher.code } });
    }
    let v = version;
    for (const e of events) {
      this.#store.append(
        {
          event_id: newId("evt"),
          event_type: e.event_type,
          aggregate_type: AggregateType.Reservation,
          aggregate_id: reservationId,
          occurred_at: this.#clock.now(),
          version: v + 1,
          summary:
            e.event_type === EventType.VoucherRevoked
              ? "旧二维码凭证随换订/取消作废"
              : "预订取消，占用容量释放",
          correlation_id: r.sessionId,
          payload: e.payload,
        },
        v,
      );
      v += 1;
    }
    return this.get(reservationId);
  }

  /** 过期报价扫描：超时未确认的占位自动释放。 */
  sweepExpired() {
    const expired = [];
    for (const r of this.#reservations.values()) {
      if (r.status === "requested" && Date.parse(r.offerExpiresAt) <= this.#clock.epochMs()) {
        this.#releaseCapacity(r.id);
        const version = this.#store.versionOf(AggregateType.Reservation, r.id);
        this.#store.append(
          {
            event_id: newId("evt"),
            event_type: EventType.ReservationOfferExpired,
            aggregate_type: AggregateType.Reservation,
            aggregate_id: r.id,
            occurred_at: this.#clock.now(),
            version: version + 1,
            summary: "报价超时未确认，占用释放",
            correlation_id: r.sessionId,
            payload: { offer_expires_at: r.offerExpiresAt },
          },
          version,
        );
        expired.push(r.id);
      }
    }
    return expired;
  }

  #releaseCapacity(reservationId) {
    const r = this.#reservations.get(reservationId);
    if (!r || r.status !== "requested" && r.status !== "confirmed") return;
    const cap = this.#capacity.get(this.#capKey(r.partyId, r.resourceId, r.date));
    if (cap) cap.held = Math.max(0, cap.held - (r.quantity ?? 1));
  }

  /** 商户/闸机扫码核验：只有 confirmed + voucher active 才放行。 */
  verifyVoucher(qrCode) {
    const r = [...this.#reservations.values()].find((x) => x.voucher?.code === qrCode);
    if (!r) return { valid: false, reason: "凭证不存在" };
    if (r.voucher.status === "revoked") return { valid: false, reason: "凭证已作废（换订/取消）", reservation_id: r.id };
    if (r.status !== "confirmed") return { valid: false, reason: `预订状态：${r.status}`, reservation_id: r.id };
    return {
      valid: true,
      reservation_id: r.id,
      party_id: r.partyId,
      resource_id: r.resourceId,
      date: r.date,
    };
  }

  get(reservationId) {
    const r = this.#reservations.get(reservationId);
    if (!r) fail("RESERVATION_NOT_FOUND", `预订不存在：${reservationId}`);
    return structuredClone(r);
  }
}
