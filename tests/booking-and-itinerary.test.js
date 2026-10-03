import assert from "node:assert/strict";
import test from "node:test";

import { bootPlatform, grantHotel } from "./helpers.js";

const CORR = "corr-demo";

test("占用幂等：同一幂等键重放返回同一占用，不重复占位", () => {
  const { platform, session } = bootPlatform();
  const args = {
    sessionId: session.session_id,
    service: "hotel:pearl",
    provider: "hotel",
    resource: "deluxe-808",
    idempotencyKey: "hold-1",
    correlationId: CORR,
    ttlMs: 600_000,
  };
  const first = platform.reservations.placeHold(args);
  assert.equal(first.replayed, false);
  const again = platform.reservations.placeHold(args);
  assert.equal(again.replayed, true);
  assert.equal(again.reservation.reservation_id, first.reservation.reservation_id);

  // 不同幂等键抢占同一活资源被拒绝。
  assert.throws(
    () => platform.reservations.placeHold({ ...args, idempotencyKey: "hold-2" }),
    (err) => err.code === "RESOURCE_ALREADY_HELD",
  );
});

test("酒店换订：旧二维码立即失效，新码绑定新占用版本；旧码核销被明确拒绝", () => {
  const { platform, session } = bootPlatform();
  grantHotel(platform, session.session_id);

  const held = platform.reservations.placeHold({
    sessionId: session.session_id,
    service: "hotel:pearl",
    provider: "hotel",
    resource: "standard-502",
    idempotencyKey: "h1",
    correlationId: CORR,
  });
  platform.reservations.confirm(held.reservation.reservation_id, CORR);
  const oldCred = platform.reservations.issueCredential(held.reservation.reservation_id, CORR);
  assert.equal(platform.reservations.verifyCredential(oldCred.token).ok, true);

  const rebooked = platform.reservations.rebook({
    oldReservationId: held.reservation.reservation_id,
    newService: "hotel:riverside",
    newResource: "river-view-1201",
    idempotencyKey: "h2",
    correlationId: CORR,
  });

  // 旧码不能再用。
  const oldScan = platform.reservations.verifyCredential(oldCred.token);
  assert.equal(oldScan.ok, false);
  assert.match(oldScan.reason, /换订|最新二维码/);

  // 新码可用，且占用版本递增。
  assert.equal(rebooked.credential.occupancy_version, 2);
  const newScan = platform.reservations.verifyCredential(rebooked.credential.token);
  assert.equal(newScan.ok, true);
  assert.equal(newScan.reservation.resource, "river-view-1201");

  // 旧预订已释放但法定留档保留（已确认过）。
  assert.equal(rebooked.old.status, "released");
  assert.equal(rebooked.old.legal_hold, true);
  assert.equal(rebooked.reservation.supersedes, held.reservation.reservation_id);
});

test("凭证签发即轮换：同一预订重复签发时只有最新码有效", () => {  const { platform, session } = bootPlatform();
  const held = platform.reservations.placeHold({
    sessionId: session.session_id,
    service: "attraction:museum",
    provider: "attraction",
    resource: "ticket-09-03-14",
    idempotencyKey: "t1",
    correlationId: CORR,
  });
  const c1 = platform.reservations.issueCredential(held.reservation.reservation_id, CORR);
  const c2 = platform.reservations.issueCredential(held.reservation.reservation_id, CORR);
  assert.equal(platform.reservations.verifyCredential(c1.token).ok, false);
  assert.equal(platform.reservations.verifyCredential(c2.token).ok, true);
});

test("酒店换订幂等：同一换订请求重放返回同一新预订，不重复占位/不重复废码", () => {
  const { platform, session } = bootPlatform();
  const held = platform.reservations.placeHold({
    sessionId: session.session_id,
    service: "hotel:pearl",
    provider: "hotel",
    resource: "standard-503",
    idempotencyKey: "rb-1",
    correlationId: CORR,
  });
  platform.reservations.confirm(held.reservation.reservation_id, CORR);
  platform.reservations.issueCredential(held.reservation.reservation_id, CORR);

  const args = {
    oldReservationId: held.reservation.reservation_id,
    newService: "hotel:riverside",
    newResource: "river-1202",
    idempotencyKey: "rb-2",
    correlationId: CORR,
  };
  const a = platform.reservations.rebook(args);
  const b = platform.reservations.rebook(args);
  assert.equal(a.reservation.reservation_id, b.reservation.reservation_id);
  assert.equal(a.credential.credential_id, b.credential.credential_id);
  // 旧预订只释放一次。
  assert.equal(platform.reservations.get(held.reservation.reservation_id).status, "released");
});

test("换订在新占用失败时保持旧预订与旧码有效（不做半吊子轮换）", () => {
  const { platform, session } = bootPlatform();
  const held = platform.reservations.placeHold({
    sessionId: session.session_id,
    service: "hotel:pearl",
    provider: "hotel",
    resource: "standard-504",
    idempotencyKey: "rb-3",
    correlationId: CORR,
  });
  const oldCred = platform.reservations.issueCredential(held.reservation.reservation_id, CORR);
  // 先占住目标资源，使换订的新占用失败。
  platform.reservations.placeHold({
    sessionId: session.session_id,
    service: "hotel:riverside",
    provider: "hotel",
    resource: "river-1203",
    idempotencyKey: "rb-4",
    correlationId: CORR,
  });
  assert.throws(
    () =>
      platform.reservations.rebook({
        oldReservationId: held.reservation.reservation_id,
        newService: "hotel:riverside",
        newResource: "river-1203",
        idempotencyKey: "rb-5",
        correlationId: CORR,
      }),
    (err) => err.code === "RESOURCE_ALREADY_HELD",
  );
  assert.equal(platform.reservations.get(held.reservation.reservation_id).status, "held");
  assert.equal(platform.reservations.verifyCredential(oldCred.token).ok, true);
});

test("已确认交通与住宿是锚点：提案静默替换被拒，新增活动允许", () => {
  const { platform, session } = bootPlatform();
  const train = platform.reservations.placeHold({
    sessionId: session.session_id,
    service: "rail:g-01",
    provider: "transport",
    resource: "G1234-3A",
    idempotencyKey: "r1",
    correlationId: CORR,
  });
  platform.reservations.confirm(train.reservation.reservation_id, CORR);

  const v1 = platform.itinerary.propose({
    sessionId: session.session_id,
    correlationId: CORR,
    changeNote: "首版：城际高铁",
    items: [
      {
        item_id: "i-train",
        type: "transport",
        provider: "transport",
        reservation_id: train.reservation.reservation_id,
        detail: { train: "G1234", car: 3 },
      },
    ],
  });
  platform.itinerary.confirm(v1.revision_id, CORR, (id) => platform.reservations.get(id));
  assert.equal(platform.itinerary.latestConfirmed(session.session_id).anchors_frozen, true);

  // 客流变化想静默把已确认车次换掉 -> 拒绝。
  const tamper = () =>
    platform.itinerary.propose({
      sessionId: session.session_id,
      correlationId: CORR,
      changeNote: "客流调整，换车次",
      items: [
        {
          item_id: "i-train",
          type: "transport",
          provider: "transport",
          reservation_id: "rsv-fake-new",
          detail: { train: "G5678", car: 9 },
        },
      ],
    });
  assert.throws(tamper, (err) => err.code === "ANCHOR_PROTECTED");

  // 删除锚点同样拒绝。
  assert.throws(
    () =>
      platform.itinerary.propose({
        sessionId: session.session_id,
        correlationId: CORR,
        changeNote: "只保留活动",
        items: [],
      }),
    (err) => err.code === "ANCHOR_PROTECTED",
  );

  // 营业时间变化：保留原车次，新增一个活动提案 -> 允许。
  const v2 = platform.itinerary.propose({
    sessionId: session.session_id,
    correlationId: CORR,
    changeNote: "博物馆延长营业，新增夜场",
    items: [
      {
        item_id: "i-train",
        type: "transport",
        provider: "transport",
        reservation_id: train.reservation.reservation_id,
        detail: { train: "G1234", car: 3 },
      },
      { item_id: "i-museum-night", type: "activity", provider: "attraction", detail: { slot: "19:00" } },
    ],
  });
  assert.equal(v2.revision_no, 2);
  assert.equal(v2.kind, "proposal");
  const diff = platform.itinerary.diff(session.session_id);
  assert.deepEqual(diff.changes.map((c) => c.kind), ["added"]);
});
