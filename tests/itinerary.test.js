import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/platform/errors.js";
import { freshPlatform, onboardedTraveler, findEvents } from "./helpers.js";

const item = (over) => ({
  item_id: over.id,
  kind: over.kind ?? "activity",
  party_id: over.party ?? "merchant-a",
  start: over.start ?? "2026-10-05T10:00:00+08:00",
  end: over.end ?? "2026-10-05T12:00:00+08:00",
  price: over.price ?? { amount: 100, currency: "CNY" },
});

function initialItinerary(p) {
  const { sessionId } = onboardedTraveler(p);
  return p.itineraries.proposeInitial(sessionId, [
    item({ id: "hotel-1", kind: "lodging", party: "hotel-lakeside", price: { amount: 680, currency: "CNY" } }),
    item({ id: "train-1", kind: "transport", party: "rail-provincial", price: { amount: 120, currency: "CNY" } }),
    item({ id: "tour-1", kind: "activity", party: "merchant-a" }),
  ]);
}

test("初始版本需接受后才成为已确认版本", () => {
  const p = freshPlatform();
  const { itineraryId } = initialItinerary(p);
  const before = p.itineraries.get(itineraryId);
  assert.equal(before.current, null);
  assert.equal(before.pending.version, 1);
  p.itineraries.accept(itineraryId);
  const after = p.itineraries.get(itineraryId);
  assert.equal(after.current.version, 1);
  assert.equal(after.pending, null);
  assert.ok(after.current.items.every((i) => i.status === "confirmed"));
});

test("涉及已确认住宿/交通的变化必须游客确认，且不静默替换当前版本", () => {
  const p = freshPlatform();
  const { itineraryId } = initialItinerary(p);
  p.itineraries.accept(itineraryId);

  // 营业时间变化：活动条目改时间（非交通住宿），仍以提案形式出现。
  let { proposal } = p.itineraries.proposeChange(
    itineraryId,
    [
      item({ id: "hotel-1", kind: "lodging", party: "hotel-lakeside", price: { amount: 680, currency: "CNY" } }),
      item({ id: "train-1", kind: "transport", party: "rail-provincial", price: { amount: 120, currency: "CNY" } }),
      item({ id: "tour-1", kind: "activity", party: "merchant-a", start: "2026-10-05T14:00:00+08:00", end: "2026-10-05T16:00:00+08:00" }),
    ],
    "商户营业时间调整",
  );
  assert.equal(proposal.requiresConfirmation, false);
  p.itineraries.reject(itineraryId);

  // 客流导致酒店涨价：已确认住宿条目价格变化 → requires_confirmation，当前版本不动。
  ({ proposal } = p.itineraries.proposeChange(
    itineraryId,
    [
      item({ id: "hotel-1", kind: "lodging", party: "hotel-lakeside", price: { amount: 880, currency: "CNY" } }),
      item({ id: "train-1", kind: "transport", party: "rail-provincial", price: { amount: 120, currency: "CNY" } }),
      item({ id: "tour-1", kind: "activity", party: "merchant-a" }),
    ],
    "国庆客流酒店价格上调",
  ));
  assert.equal(proposal.requiresConfirmation, true);
  assert.ok(proposal.changes.some((c) => c.kind === "price_changed" && c.was_confirmed));
  const currentStillV1 = p.itineraries.get(itineraryId).current;
  assert.equal(currentStillV1.version, 1);
  assert.equal(currentStillV1.items.find((i) => i.item_id === "hotel-1").price.amount, 680);
});

test("接受换酒店方案后产出 superseded 清单供编排层换订", () => {
  const p = freshPlatform();
  const { itineraryId } = initialItinerary(p);
  p.itineraries.accept(itineraryId);
  p.itineraries.proposeChange(
    itineraryId,
    [
      item({ id: "hotel-1", kind: "lodging", party: "hotel-riverside", price: { amount: 680, currency: "CNY" } }),
      item({ id: "train-1", kind: "transport", party: "rail-provincial", price: { amount: 120, currency: "CNY" } }),
      item({ id: "tour-1", kind: "activity", party: "merchant-a" }),
    ],
    "湖畔酒店满房，推荐滨江酒店",
  );
  const { current, superseded } = p.itineraries.accept(itineraryId);
  assert.equal(current.version, 2);
  assert.deepEqual(
    superseded.map((s) => ({ item: s.item_id, change: s.change })),
    [{ item: "hotel-1", change: "merchant_changed" }],
  );
});

test("同一行程存在待确认方案时不能再提新方案", () => {
  const p = freshPlatform();
  const { itineraryId } = initialItinerary(p);
  assert.throws(
    () => p.itineraries.proposeChange(itineraryId, p.itineraries.get(itineraryId).pending.items, "x"),
    (e) => e instanceof DomainError && e.code === "PROPOSAL_PENDING",
  );
});
