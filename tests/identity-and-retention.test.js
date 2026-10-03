import assert from "node:assert/strict";
import test from "node:test";

import { AssertionScope, RetentionClass } from "../src/contracts.js";
import { bootPlatform, countEvents, findEvents, grant, grantHotel, PASSPORT } from "./helpers.js";

test("护照原件只密封一次：任何事件与断言中都不出现原件字段", () => {
  const { platform, session } = bootPlatform();
  grantHotel(platform, session.session_id);
  platform.authorizeAndAssert({
    sessionId: session.session_id,
    service: "merchant:tea-stall",
    purposes: ["入境资格核验"],
    scope: AssertionScope.EntryEligibility,
  });

  const blob = JSON.stringify(platform.events());
  for (const secret of [PASSPORT.passport_number, PASSPORT.surname, PASSPORT.given_name, PASSPORT.nationality, PASSPORT.date_of_birth]) {
    assert(!blob.includes(secret), `事件流中泄露原件内容：${secret}`);
  }
});

test("只需确认资格的商户拿到的是布尔资格，而不是证件信息", () => {
  const { platform, session } = bootPlatform();
  const assertion = platform.authorizeAndAssert({
    sessionId: session.session_id,
    service: "merchant:tea-stall",
    purposes: ["入境资格核验"],
    scope: AssertionScope.EntryEligibility,
  });
  assert.equal(assertion.result, true);
  assert.equal(typeof assertion.result, "boolean");

  const adult = platform.authorizeAndAssert({
    sessionId: session.session_id,
    service: "merchant:bar",
    purposes: ["成年资格核验"],
    scope: AssertionScope.AdultStatus,
  });
  assert.equal(adult.result, true);
});

test("酒店得到的是登记化名，化名不可逆出真实姓名", () => {
  const { platform, session } = bootPlatform();
  const alias = grantHotel(platform, session.session_id);
  assert.equal(typeof alias.result, "string");
  assert.match(alias.result, /^入住宾客 /);
  assert(!alias.result.includes(PASSPORT.surname));
});

test("无授权访问密封件被拒绝并留审计；运维只能看到拒绝元数据", () => {
  const { platform, session, sealedRef } = bootPlatform();
  assert.throws(
    () =>
      platform.vault.accessSealed(sealedRef, {
        service: "merchant:tea-stall",
        purpose: "私自拉取护照",
        authorized: false,
      }),
    /密封访问被拒绝/,
  );
  const trail = platform.vault.auditTrail(sealedRef);
  assert.equal(trail.at(-1).allowed, false);
  assert.match(trail.at(-1).reason, /授权/);
});

test("撤回授权只阻断后续用途：新断言被拒，既有记录仍可查，撤回事件注明留档保留", () => {
  const { platform, session } = bootPlatform();
  const auth = grant(platform, session.session_id, "merchant:tea-stall", ["入境资格核验"], AssertionScope.EntryEligibility);
  const first = platform.assertions.issue({
    sealedRef: session.sealed_ref,
    sessionId: session.session_id,
    service: "merchant:tea-stall",
    purpose: "入境资格核验",
    scope: AssertionScope.EntryEligibility,
    authorized: true,
  });
  assert.equal(first.status, "valid");

  platform.revokeAuthorization({ authorizationId: auth.authorization_id, reason: "游客不希望该商户继续使用" });

  assert.equal(platform.sessions.isAuthorized(session.session_id, "merchant:tea-stall", "入境资格核验", AssertionScope.EntryEligibility), false);
  assert.equal(platform.assertions.isValid(first.assertion_id), false);
  assert.throws(
    () =>
      platform.assertions.issue({
        sealedRef: session.sealed_ref,
        sessionId: session.session_id,
        service: "merchant:tea-stall",
        purpose: "入境资格核验",
        scope: AssertionScope.EntryEligibility,
        authorized: platform.sessions.isAuthorized(session.session_id, "merchant:tea-stall", "入境资格核验", AssertionScope.EntryEligibility),
      }),
    /授权缺失/,
  );

  // 授权记录本身仍在（游客可回看），事件显式说明不破坏法定留档。
  const revokedEvent = findEvents(platform, "AUTHORIZATION_REVOKED").at(-1);
  assert.equal(revokedEvent.payload.retained, true);
  const listed = platform.sessions.listAuthorizations(session.session_id).find((a) => a.authorization_id === auth.authorization_id);
  assert.equal(listed.status, "revoked");
});

test("保留清理：会话工作数据到期删除，法定留档到期也保留并分别落事件", () => {
  const { platform, clock, sealedRef } = bootPlatform();

  // 退税材料：法定留档密封件（无 TTL，legal_hold）。
  const taxAuth = grant(platform, platform.sessions.sessions.values().next().value.session_id, "tax_refund", ["退税办理"], AssertionScope.TaxRefundEligibility);
  const sid = taxAuth.session_id;
  platform.assertions.issue({
    sealedRef,
    sessionId: sid,
    service: "tax_refund",
    purpose: "退税办理",
    scope: AssertionScope.TaxRefundEligibility,
    authorized: true,
  });
  const pack = platform.taxRefund.collect({
    sessionId: sid,
    correlationId: platform.sessions.getSession(sid).correlation_id,
    eligible: true,
    authorized: true,
    documents: [{ name: "退税单.pdf", content: { invoice: "INV-1", amount: 800 } }],
  });

  // 31 天后清理：护照会话密封件过期且无 legal hold -> 删除；
  clock.advance(1000 * 60 * 60 * 24 * 31);
  const result = platform.sweepRetention();
  assert(result.purged.includes(sealedRef));
  assert(result.retained.includes(pack.sealed_ref));
  assert(countEvents(platform, "DATA_PURGED") >= 1);
  assert(countEvents(platform, "DATA_RETENTION_EXPIRED") >= 1);

  // 再次清理幂等：已删除的不再重复落事件。
  const purgedEventsBefore = countEvents(platform, "DATA_PURGED");
  platform.sweepRetention();
  assert.equal(countEvents(platform, "DATA_PURGED"), purgedEventsBefore);

  // 退税法定留档材料仍可取回（程序性通道），而护照工作原件已不可访问。
  const retained = platform.vault.seals.get(pack.sealed_ref);
  assert.equal(retained.purged, false);
  assert.equal(platform.vault.seals.get(sealedRef).purged, true);
  assert.equal(RetentionClass.TaxRefundRecord, retained.retention_class);
});
