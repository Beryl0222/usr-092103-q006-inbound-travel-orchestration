import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/platform/errors.js";
import { freshPlatform, onboardedTraveler, findEvents } from "./helpers.js";

function purchases() {
  return [
    {
      receipt_ref: "RC-1001",
      merchant_party_id: "shop-tea",
      amount: { amount: 800, currency: "CNY" },
      date: "2026-10-02",
    },
  ];
}

test("退税材料经一次性护照读取生成，护照字段只出现在 vault 审计而非退税聚合事件", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = onboardedTraveler(p, {
    partyId: "tax-agency",
    purpose: "tax_refund",
    scopes: ["tax_refund"],
  });
  const taxCase = p.taxRefund.prepare({
    sessionId,
    vaultId,
    authId,
    partyId: "tax-agency",
    purchases: purchases(),
  });
  assert.equal(taxCase.total_amount.amount, 800);
  assert.equal(taxCase.legal_hold, true);
  assert.ok(taxCase.retain_until);
  // 退税聚合事件载荷不复制护照号原件。
  const taxEvents = p.store.loadStream("tax_refund_case", taxCase.id);
  assert.ok(!JSON.stringify(taxEvents).includes("E12345678"));
  // 但 vault 中确有一次“退税开单”目的的护照读取审计。
  const trail = p.identity.auditTrail(vaultId);
  const read = trail.filter((a) => a.reason === "read");
  assert.equal(read.length, 1);
  assert.equal(read[0].party_id, "tax-agency");
});

test("缺少 tax_refund 授权或授权撤回后不能再准备新材料", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = onboardedTraveler(p, {
    partyId: "tax-agency",
    purpose: "tax_refund",
    scopes: ["tax_refund"],
  });
  p.taxRefund.prepare({ sessionId, vaultId, authId, partyId: "tax-agency", purchases: purchases() });
  p.authorization.revoke(authId);
  assert.throws(
    () =>
      p.taxRefund.prepare({ sessionId, vaultId, authId, partyId: "tax-agency", purchases: purchases() }),
    (e) => e instanceof DomainError && e.code === "AUTHORIZATION_REVOKED",
  );
  // 已生成的退税案件仍在（法定留档不被撤回破坏）。
  assert.equal(p.taxRefund.listBySession(sessionId).length, 1);
});

test("非退税服务方不能出具退税材料", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = onboardedTraveler(p, { scopes: ["tax_refund"] });
  assert.throws(
    () =>
      p.taxRefund.prepare({
        sessionId,
        vaultId,
        authId,
        partyId: "hotel-lakeside",
        purchases: purchases(),
      }),
    (e) => e.code === "WRONG_PARTY_KIND",
  );
});

test("退税准备流程可由编排器执行", () => {
  const p = freshPlatform();
  const { sessionId, vaultId, authId } = onboardedTraveler(p, {
    partyId: "tax-agency",
    purpose: "tax_refund",
    scopes: ["tax_refund"],
  });
  const flow = p.orchestrator.start("tax_refund_prep", {
    sessionId,
    startKey: "tax-1",
    input: { vault_id: vaultId, auth_id: authId, purchases: purchases() },
  });
  assert.equal(flow.status, "completed");
  assert.equal(findEvents(p.store, "TAX_REFUND_DOCUMENT_PREPARED").length, 1);
});
