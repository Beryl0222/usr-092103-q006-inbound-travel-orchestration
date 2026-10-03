import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/platform/errors.js";
import { freshPlatform, onboardedTraveler, findEvents } from "./helpers.js";

function setup(p, party = "hotel-lakeside") {
  const { sessionId } = onboardedTraveler(p, { partyId: party });
  p.reservations.addCapacity(party, "room-501", "2026-10-05", 2);
  return sessionId;
}

test("占位排他：库存不足被拒绝，占位减少可用量", () => {
  const p = freshPlatform();
  const sessionId = setup(p);
  const r1 = p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", quantity: 2, idempotencyKey: "k1",
  });
  assert.equal(r1.status, "requested");
  assert.deepEqual(p.reservations.occupancy("hotel-lakeside", "room-501", "2026-10-05").available, 0);
  assert.throws(
    () =>
      p.reservations.request({
        sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
        date: "2026-10-05", quantity: 1, idempotencyKey: "k2",
      }),
    (e) => e instanceof DomainError && e.code === "NO_CAPACITY",
  );
});

test("重复预订请求（同幂等键）回放同一预订，不二次占位", () => {
  const p = freshPlatform();
  const sessionId = setup(p);
  const args = {
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", quantity: 1, idempotencyKey: "same-key",
  };
  const a = p.reservations.request(args);
  const b = p.reservations.request(args);
  assert.equal(a.id, b.id);
  assert.equal(findEvents(p.store, "RESERVATION_REQUESTED").length, 1);
  assert.equal(p.reservations.occupancy("hotel-lakeside", "room-501", "2026-10-05").held, 1);
});

test("报价超时未确认自动释放占位", () => {
  const p = freshPlatform();
  const sessionId = setup(p);
  p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", idempotencyKey: "k1", offerTtlMs: 900_000,
  });
  p.clock.advance(900_001);
  const expired = p.reservations.sweepExpired();
  assert.equal(expired.length, 1);
  assert.equal(p.reservations.occupancy("hotel-lakeside", "room-501", "2026-10-05").held, 0);
});

test("确认回调重复到达只签发一张二维码", () => {
  const p = freshPlatform();
  const sessionId = setup(p);
  const r = p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", idempotencyKey: "k1",
  });
  const cb = { callbackId: "cb-1", reservationId: r.id, accepted: true, reservationRef: "HTL-1" };
  const c1 = p.reservations.confirmCallback("hotel-lakeside", cb);
  const c2 = p.reservations.confirmCallback("hotel-lakeside", cb);
  assert.equal(c1.id, c2.id);
  assert.equal(findEvents(p.store, "VOUCHER_ISSUED").length, 1);
  // 即便对方换了回调编号重发确认，也不会再发一张码。
  const c3 = p.reservations.confirmCallback("hotel-lakeside", { ...cb, callbackId: "cb-2" });
  assert.equal(c3.voucher.code, c1.voucher.code);
  assert.equal(findEvents(p.store, "VOUCHER_ISSUED").length, 1);
});

test("酒店换订：旧单取消后旧二维码立即失效，新单新码有效", () => {
  const p = freshPlatform();
  const sessionId = setup(p, "hotel-lakeside");
  p.reservations.addCapacity("hotel-riverside", "room-303", "2026-10-05", 1);
  const old = p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", idempotencyKey: "old",
  });
  p.reservations.confirmCallback("hotel-lakeside", {
    callbackId: "cb-old", reservationId: old.id, accepted: true, reservationRef: "OLD",
  });
  const oldCode = p.reservations.get(old.id).voucher.code;
  assert.equal(p.reservations.verifyVoucher(oldCode).valid, true);

  const cancelled = p.reservations.cancel(old.id, "游客换订至滨江酒店");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.voucher.status, "revoked");
  assert.equal(p.reservations.verifyVoucher(oldCode).valid, false);
  // 取消幂等，不重复释放容量。
  p.reservations.cancel(old.id);
  assert.equal(p.reservations.occupancy("hotel-lakeside", "room-501", "2026-10-05").held, 0);

  const next = p.reservations.request({
    sessionId, partyId: "hotel-riverside", resourceId: "room-303",
    date: "2026-10-05", idempotencyKey: "new",
  });
  p.reservations.confirmCallback("hotel-riverside", {
    callbackId: "cb-new", reservationId: next.id, accepted: true, reservationRef: "NEW",
  });
  const newCode = p.reservations.get(next.id).voucher.code;
  assert.notEqual(newCode, oldCode);
  assert.equal(p.reservations.verifyVoucher(newCode).valid, true);
});

test("预订被拒绝释放占位且不发码", () => {
  const p = freshPlatform();
  const sessionId = setup(p);
  const r = p.reservations.request({
    sessionId, partyId: "hotel-lakeside", resourceId: "room-501",
    date: "2026-10-05", idempotencyKey: "k1",
  });
  p.reservations.confirmCallback("hotel-lakeside", {
    callbackId: "cb-x", reservationId: r.id, accepted: false, reason: "到店无房",
  });
  assert.equal(p.reservations.get(r.id).status, "rejected");
  assert.equal(p.reservations.occupancy("hotel-lakeside", "room-501", "2026-10-05").held, 0);
  assert.equal(findEvents(p.store, "VOUCHER_ISSUED").length, 0);
});
