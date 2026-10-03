import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/platform/errors.js";
import { freshPlatform, onboardedTraveler, PASSPORT } from "./helpers.js";

test("护照原件进入 vault，会话只持有 vault 编号", () => {
  const p = freshPlatform();
  const { sessionId, vaultId } = onboardedTraveler(p);
  const session = p.identity.getSession(sessionId);
  assert.equal(session.verified, true);
  assert.equal(session.vaultId, vaultId);
  // 会话事件载荷中不得出现护照号/出生日期等原件字段。
  const sessionEvents = p.store.loadStream("traveler_session", sessionId);
  const serialized = JSON.stringify(sessionEvents);
  assert.ok(!serialized.includes(PASSPORT.passport_number));
  assert.ok(!serialized.includes(PASSPORT.date_of_birth));
});

test("向酒店签发的最小断言只含白名单字段与资格结论", () => {
  const p = freshPlatform();
  const { vaultId } = onboardedTraveler(p, { partyId: "hotel-lakeside" });
  const assertion = p.identity.issueAssertion({
    vaultId,
    partyId: "hotel-lakeside",
    purpose: "lodging_checkin",
  });
  assert.deepEqual(Object.keys(assertion.fields), ["full_name"]);
  assert.equal(assertion.fields.passport_number, undefined);
  assert.equal(assertion.fields.date_of_birth, undefined);
  assert.equal(assertion.qualification.visa_valid, true);
  // 铁路白名单不同：姓名 + 国籍。
  const rail = p.identity.issueAssertion({
    vaultId,
    partyId: "rail-provincial",
    purpose: "transport_checkin",
  });
  assert.deepEqual(Object.keys(rail.fields).sort(), ["full_name", "nationality"]);
});

test("护照原件读取需要授权、单次用后即焚、每次留审计", () => {
  const p = freshPlatform();
  const { vaultId } = onboardedTraveler(p, { partyId: "tax-agency", scopes: ["tax_refund"] });
  const grantId = p.identity.grantPassportAccess({
    vaultId,
    partyId: "tax-agency",
    purpose: "tax_refund_document",
    fields: ["full_name", "passport_number"],
  });
  const extract = p.identity.readPassport(vaultId, grantId);
  assert.equal(extract.passport_number, PASSPORT.passport_number);
  assert.throws(
    () => p.identity.readPassport(vaultId, grantId),
    (e) => e instanceof DomainError && e.code === "ACCESS_GRANT_EXHAUSTED",
  );
  const trail = p.identity.auditTrail(vaultId);
  assert.ok(trail.some((a) => a.reason === "read" && a.party_id === "tax-agency"));
});

test("伪造的 grant 无法读取护照", () => {
  const p = freshPlatform();
  const { vaultId } = onboardedTraveler(p);
  assert.throws(
    () => p.identity.readPassport(vaultId, "grant-does-not-exist"),
    (e) => e.code === "ACCESS_GRANT_NOT_FOUND",
  );
});

test("授权撤回只阻断后续用途，不影响已完成交易的法定留档", () => {
  const p = freshPlatform();
  const { authId } = onboardedTraveler(p);
  // 一笔已完成交易进入法定留档。
  p.authorization.holdLegalRecord(authId, {
    transactionRef: "res-done",
    partyId: "hotel-lakeside",
    scope: "lodging_checkin",
    retainUntil: "2027-10-03T00:00:00Z",
    reason: "住宿登记",
  });
  p.authorization.revoke(authId, "游客改主意了");
  assert.throws(
    () => p.authorization.assertUsable(authId, "lodging_checkin"),
    (e) => e.code === "AUTHORIZATION_REVOKED",
  );
  const records = p.authorization.legalRecords(authId);
  assert.equal(records.length, 1);
  assert.equal(records[0].transaction_ref, "res-done");
  // 撤回幂等：再次撤回不产生新事件。
  const before = p.store.all().length;
  p.authorization.revoke(authId);
  assert.equal(p.store.all().length, before);
});

test("授权过期与超范围用途被拒绝", () => {
  const p = freshPlatform();
  const { authId } = onboardedTraveler(p, { scopes: ["lodging_checkin"], ttlMs: 10 });
  p.clock.advance(20);
  assert.throws(
    () => p.authorization.assertUsable(authId, "lodging_checkin"),
    (e) => e.code === "AUTHORIZATION_EXPIRED",
  );
  const { authId: auth2 } = onboardedTraveler(p);
  assert.throws(
    () => p.authorization.assertUsable(auth2, "tax_refund"),
    (e) => e.code === "SCOPE_DENIED",
  );
});
