import assert from "node:assert/strict";
import test from "node:test";

import { AssertionScope } from "../src/contracts.js";
import { bootPlatform, countEvents, findEvents, grant } from "./helpers.js";

const CORR = "corr-misc";

test("拍照翻译保留原图来源、置信度与过敏原提示；低置信度显式警示", () => {
  const { platform, session } = bootPlatform();
  const image = Buffer.from(
    JSON.stringify({
      text: "Kung Pao Shrimp 腰果虾仁, contains shrimp 虾 and peanut 花生",
      translation: "宫保虾：含虾和花生",
      confidence: 0.62,
    }),
    "utf8",
  );
  const t = platform.translation.request({
    sessionId: session.session_id,
    correlationId: CORR,
    image,
    source: { channel: "visitor-app-ios", capturedAt: "2026-10-03T12:30:00+08:00" },
  });
  assert.equal(t.source.channel, "visitor-app-ios");
  assert.match(t.source.image_hash, /^[a-f0-9]{64}$/);
  assert.equal(t.confidence, 0.62);
  assert(t.low_confidence_warning);
  assert(t.allergen_flags.includes("虾"));
  assert(t.allergen_flags.includes("花生"));
  // 原图内容哈希之外不存影像：事件里没有图片原文。
  const blob = JSON.stringify(findEvents(platform, "TRANSLATION_REQUESTED"));
  assert(!blob.includes("Kung Pao"));
});

test("人工更正追加留痕，机器识别原文与置信度保留", () => {
  const { platform, session } = bootPlatform();
  const image = Buffer.from(JSON.stringify({ text: "不含过敏原的时蔬", confidence: 0.95 }), "utf8");
  const t = platform.translation.request({ sessionId: session.session_id, correlationId: CORR, image });
  const corrected = platform.translation.correct({
    translationId: t.translation_id,
    correctedBy: "游客本人",
    toText: "时令蔬菜（无过敏原）",
  });
  assert.equal(corrected.corrections.length, 1);
  assert.equal(corrected.corrections[0].from_text, "【机器翻译】不含过敏原的时蔬");
  assert.equal(corrected.translated_text, "时令蔬菜（无过敏原）");
  assert.equal(corrected.detected_text, "不含过敏原的时蔬");
  assert.equal(corrected.confidence, 0.95);
  assert(countEvents(platform, "TRANSLATION_CORRECTED") >= 1);
});

test("退税：资格用布尔断言；材料密封留档；撤回授权阻断报送但不毁档", () => {
  const { platform, session, sealedRef } = bootPlatform();
  const auth = grant(platform, session.session_id, "tax_refund", ["退税办理"], AssertionScope.TaxRefundEligibility);
  const eligibility = platform.assertions.issue({
    sealedRef,
    sessionId: session.session_id,
    service: "tax_refund",
    purpose: "退税办理",
    scope: AssertionScope.TaxRefundEligibility,
    authorized: true,
  });
  assert.equal(eligibility.result, true);

  const pack = platform.taxRefund.collect({
    sessionId: session.session_id,
    correlationId: CORR,
    eligible: true,
    authorized: true,
    documents: [{ name: "退税单.pdf", content: { invoice: "INV-9", amount: 1200 } }],
  });
  assert.equal(pack.legal_hold, true);

  // 撤回授权后：报送被阻断，材料仍在且可程序性读取。
  platform.revokeAuthorization({ authorizationId: auth.authorization_id, reason: "行程结束，不再授权退税用途" });
  assert.throws(() => platform.taxRefund.submit(pack.pack_id), (err) => err.code === "FURTHER_USE_BLOCKED");
  const packAfter = platform.taxRefund.listBySession(session.session_id)[0];
  assert.equal(packAfter.further_use_blocked, true);
  assert.equal(packAfter.legal_hold, true);
  const seal = platform.vault.seals.get(pack.sealed_ref);
  assert.equal(seal.purged, false);
  assert.equal(seal.legal_hold, true);
});

test("游客视图：逐步显示处理方与失败续办指引；运维视图脱敏可追踪", async () => {
  const { platform, session } = bootPlatform();
  const { RetryableError } = await import("../src/runtime/orchestration.js");

  const { correlationId } = platform.orchestration.define({
    sessionId: session.session_id,
    correlationId: CORR,
    flowName: "一站式入境（核验后办理）",
    steps: [
      {
        name: "酒店入住登记",
        provider: "hotel",
        action: async () => "ok",
        recoveryHint: "可前往前台人工办理",
      },
      {
        name: "外卡充值",
        provider: "payment_network",
        action: async () => {
          throw new RetryableError("充值通道超时");
        },
        recoveryHint: "可稍后在钱包页重试，或改用现金充值点",
      },
    ],
  });
  await platform.orchestration.run(correlationId, {});

  const dash = platform.views.travelerDashboard(session.session_id);
  const flow = dash.编排[0];
  assert.equal(flow.步骤[0].处理方, "酒店住宿");
  assert.equal(flow.步骤[0].状态, "已回退");
  assert.equal(flow.步骤[1].处理方, "外卡支付网络");
  assert.match(flow.步骤[1].后续怎么办, /钱包页重试/);
  assert.equal(dash.会话.护照原件, "已密封保管，商户不可见");

  const ops = platform.views.opsTrace(correlationId);
  assert(ops.事件时间线.length > 5);
  assert(ops.统计.补偿事件 >= 2);
  const serialized = JSON.stringify(ops);
  for (const secret of ["E12345678", "SMITH", "JANE"]) {
    assert(!serialized.includes(secret), "运维视图泄露身份资料");
  }
  // 运维视图不含 payload（防止 sealed_ref/资料随追踪下发）。
  assert(!serialized.includes("sealed_ref"));
  assert.match(ops.脱敏声明, /不含护照号/);
  assert.equal(ops.失败步骤[0].处理方, "外卡支付网络");

  // 未知追踪号报错而不是返回空壳。
  assert.throws(() => platform.views.opsTrace("nope"), /找不到/);
});
