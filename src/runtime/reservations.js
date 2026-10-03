import { randomUUID } from "node:crypto";
import { AggregateType, EventType } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 预订占用与凭证（二维码）服务。
 *
 * 关键规则：
 * 1. 占用幂等：同一 idempotency_key 的重复请求回放同一占用，不会重复占位。
 * 2. 凭证与“具体一次占用”绑定（reservation_id + occupancy_version）。
 *    酒店换订即产生新预订、新版本、新二维码，并立即作废旧码（CREDENTIAL_ROTATED）。
 *    商户扫旧码时明确得到“已换订失效”，而不是放行。
 * 3. 已确认预订带 legal_hold：换订/释放/撤回都不删除法定留档，只阻断后续使用。
 */
export class ReservationService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    /** @type {Map<string, any>} reservation_id -> state */
    this.reservations = new Map();
    /** @type {Map<string, any>} credential token -> state */
    this.credentials = new Map();
    /** @type {Map<string, string>} idempotency_key -> reservation_id */
    this.holdKeys = new Map();
    /** 资源 -> 当前占用者，用于检测同一资源重复占位 */
    this.resourceLocks = new Map();
  }

  /**
   * 放置占用（幂等）。
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} args.service 服务方标识，如 hotel:hotel-pearl
   * @param {string} args.provider 契约服务方枚举
   * @param {string} args.resource 资源键（房型/车次/票档）
   * @param {string} args.idempotencyKey 调用方幂等键
   * @param {string} args.correlationId
   * @param {number} [args.ttlMs]
   */
  placeHold({ sessionId, service, provider, resource, idempotencyKey, correlationId, ttlMs }) {
    const replayedId = this.holdKeys.get(idempotencyKey);
    if (replayedId) {
      return { reservation: this.#external(this.reservations.get(replayedId)), replayed: true };
    }
    const owner = this.resourceLocks.get(resource);
    if (owner && this.#isLive(owner)) {
      const err = new Error(`资源 ${resource} 已被占用（reservation ${owner}）`);
      err.code = "RESOURCE_ALREADY_HELD";
      throw err;
    }

    const reservationId = this.clock.id("rsv");
    const state = {
      reservation_id: reservationId,
      session_id: sessionId,
      service,
      provider,
      resource,
      status: "held",
      occupancy_version: 1,
      legal_hold: false,
      expires_at: ttlMs
        ? new Date(new Date(this.clock.now()).getTime() + ttlMs).toISOString()
        : undefined,
      supersedes: undefined,
    };
    this.reservations.set(reservationId, state);
    this.holdKeys.set(idempotencyKey, reservationId);
    this.resourceLocks.set(resource, reservationId);

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.ReservationHeld,
        aggregateType: AggregateType.Reservation,
        aggregateId: reservationId,
        correlationId,
        idempotencyKey,
        provider,
        summary: `${service} 占用 ${resource}`,
        payload: { session_id: sessionId, service, reservation_id: reservationId, resource },
      }),
      { idempotencyKey },
    );
    return { reservation: this.#external(state), replayed: false };
  }

  /** 确认预订：商户与游客达成正式交易，此后进入法定留档。 */
  confirm(reservationId, correlationId) {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error("预订不存在");
    if (r.status === "confirmed") return this.#external(r);
    if (r.status !== "held") throw new Error(`占用处于 ${r.status}，不能确认`);
    r.status = "confirmed";
    r.legal_hold = true;

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.ReservationConfirmed,
        aggregateType: AggregateType.Reservation,
        aggregateId: reservationId,
        correlationId,
        provider: r.provider,
        summary: `${r.service} 的 ${r.resource} 已确认，纳入法定留档`,
        payload: {
          session_id: r.session_id,
          service: r.service,
          reservation_id: reservationId,
          retained: true,
          legal_hold: true,
        },
      }),
    );
    return this.#external(r);
  }

  /** 释放占用（超时取消或补偿）。已确认预订释放时保留法定留档标记。 */
  release(reservationId, reason, correlationId) {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error("预订不存在");
    if (r.status === "released") return this.#external(r);
    r.status = "released";
    if (this.resourceLocks.get(r.resource) === reservationId) this.resourceLocks.delete(r.resource);

    // 所有活跃凭证立即失效。
    for (const cred of this.credentials.values()) {
      if (cred.reservation_id === reservationId && cred.status === "active") {
        cred.status = "revoked";
        cred.revoked_at = this.clock.now();
      }
    }

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.ReservationReleased,
        aggregateType: AggregateType.Reservation,
        aggregateId: reservationId,
        correlationId,
        provider: r.provider,
        summary: `释放 ${r.service}/${r.resource}：${reason}${r.legal_hold ? "（法定留档保留）" : ""}`,
        payload: {
          session_id: r.session_id,
          service: r.service,
          reservation_id: reservationId,
          reason,
          retained: r.legal_hold,
          legal_hold: r.legal_hold,
        },
      }),
    );
    return this.#external(r);
  }

  /**
   * 为预订签发入住/核销二维码。
   * 每次（重新）签发都使该预订上的旧码轮换失效，保证一预订一码。
   */
  issueCredential(reservationId, correlationId) {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error("预订不存在");
    if (!this.#isLive(reservationId)) throw new Error("预订已失效，不能签发二维码");

    const superseded = [];
    for (const cred of this.credentials.values()) {
      if (cred.reservation_id === reservationId && cred.status === "active") {
        cred.status = "rotated";
        cred.rotated_at = this.clock.now();
        superseded.push(cred.credential_id);
      }
    }

    const credentialId = this.clock.id("cred");
    const token = `QR-${randomUUID()}`;
    const cred = {
      credential_id: credentialId,
      token,
      session_id: r.session_id,
      reservation_id: reservationId,
      service: r.service,
      provider: r.provider,
      occupancy_version: r.occupancy_version,
      status: "active",
      issued_at: this.clock.now(),
    };
    this.credentials.set(token, cred);
    r.credential_id = token;

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.CredentialRotated,
        aggregateType: AggregateType.Credential,
        aggregateId: credentialId,
        correlationId,
        provider: r.provider,
        summary: `向 ${r.service} 签发二维码${superseded.length ? "，旧码已轮换失效" : ""}`,
        payload: {
          session_id: r.session_id,
          service: r.service,
          reservation_id: reservationId,
          credential_id: credentialId,
          superseded_credential_id: superseded[0],
          occupancy_version: r.occupancy_version,
        },
      }),
    );
    return cred;
  }

  /**
   * 商户扫码核销。旧码/已换订码必须被拒绝，并给出明确原因。
   * @returns {{ok: true, reservation: object} | {ok: false, reason: string}}
   */
  verifyCredential(token) {
    const cred = this.credentials.get(token);
    if (!cred) return { ok: false, reason: "二维码不存在" };
    const r = this.reservations.get(cred.reservation_id);
    if (!r) return { ok: false, reason: "关联预订不存在" };
    if (cred.status !== "active") {
      return { ok: false, reason: `二维码已${cred.status === "rotated" ? "被换订轮换" : "撤销"}，请使用最新二维码` };
    }
    if (cred.occupancy_version !== r.occupancy_version) {
      return { ok: false, reason: "二维码与当前占用版本不一致（已换订）" };
    }
    if (!this.#isLive(cred.reservation_id)) {
      return { ok: false, reason: `预订状态为 ${r.status}，二维码不可用` };
    }
    return { ok: true, reservation: this.#external(r) };
  }

  /**
   * 酒店换订：旧预订释放（留档保留），新占用就位，旧码立即失效并签发新码。
   * 这是“一次酒店换订不让旧二维码继续有效”的显式入口。
   */
  rebook({ oldReservationId, newService, newResource, idempotencyKey, correlationId, ttlMs }) {
    const old = this.reservations.get(oldReservationId);
    if (!old) throw new Error("旧预订不存在");

    // 换订整体幂等：同一幂等键重放时返回既有新预订与当前有效凭证。
    const replayId = this.holdKeys.get(idempotencyKey);
    if (replayId) {
      const existing = this.reservations.get(replayId);
      if (existing && existing.supersedes === oldReservationId) {
        const cred = [...this.credentials.values()]
          .filter((c) => c.reservation_id === replayId && c.status === "active")
          .at(-1);
        return { old: this.#external(this.reservations.get(oldReservationId)), reservation: this.#external(existing), credential: cred };
      }
    }

    // 先建立新占用；若这一步失败，旧预订与旧码保持有效（不做半吊子轮换）。
    const placed = this.placeHold({
      sessionId: old.session_id,
      service: newService,
      provider: old.provider,
      resource: newResource,
      idempotencyKey,
      correlationId,
      ttlMs,
    });

    // 新占用就位后，旧码标记为“换订轮换”（而非普通撤销），商户扫码能看到准确原因。
    for (const cred of this.credentials.values()) {
      if (cred.reservation_id === oldReservationId && cred.status === "active") {
        cred.status = "rotated";
        cred.rotated_at = this.clock.now();
        cred.rotate_reason = "酒店换订";
      }
    }

    const fresh = this.reservations.get(placed.reservation.reservation_id);
    fresh.supersedes = oldReservationId;
    fresh.occupancy_version = old.occupancy_version + 1;
    fresh.legal_hold = old.legal_hold; // 留档义务随换订延续

    // 旧预订释放：其 legal_hold 不被清除，事件中注明保留。
    this.release(oldReservationId, "游客换订，被新预订取代", correlationId);
    const credential = this.issueCredential(fresh.reservation_id, correlationId);
    return { old: this.#external(old), reservation: this.#external(fresh), credential };
  }

  get(reservationId) {
    const r = this.reservations.get(reservationId);
    return r ? this.#external(r) : null;
  }

  listBySession(sessionId) {
    return [...this.reservations.values()].filter((r) => r.session_id === sessionId).map((r) => this.#external(r));
  }

  #isLive(reservationId) {
    const r = this.reservations.get(reservationId);
    return Boolean(r && (r.status === "held" || r.status === "confirmed" || r.status === "compensating"));
  }

  #external(r) {
    return { ...r };
  }
}
