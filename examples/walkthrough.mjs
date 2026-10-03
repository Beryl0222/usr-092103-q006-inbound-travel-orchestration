/**
 * 端到端演示：一位外国游客从同一入口完成
 * 护照核验 → 酒店入住 → 外卡充值 → 行程规划 → 拍照翻译 → 退税准备，
 * 中途经历换订、重复回调、超时补偿与授权撤回。
 *
 * 运行：node examples/walkthrough.mjs
 */
import { AssertionScope } from "../src/contracts.js";
import { Platform } from "../src/runtime/platform.js";
import { RetryableError } from "../src/runtime/orchestration.js";

const line = (t) => console.log(`\n=== ${t} ===`);
const platform = new Platform();

// 1) 护照核验：原件只在此刻出现，随后密封。
line("1. 护照核验（原件密封，商户不可见）");
const { session } = platform.verifyPassport({
  rawPassport: {
    surname: "SMITH",
    given_name: "JANE",
    passport_number: "E12345678",
    date_of_birth: "1990-06-01",
    nationality: "CAN",
    visa_class: "tourist_short_stay",
  },
});
const corr = session.correlation_id;
console.log("会话：", session.session_id, "追踪号：", corr);

// 2) 酒店：授权 → 最小断言（化名）→ 占位 → 确认 → 二维码。
line("2. 酒店入住：商户只拿到入住化名与二维码");
platform.authorizeAndAssert({
  sessionId: session.session_id,
  service: "hotel:pearl",
  purposes: ["入住登记"],
  scope: AssertionScope.HotelRegistrationAlias,
});
const hold = platform.reservations.placeHold({
  sessionId: session.session_id,
  service: "hotel:pearl",
  provider: "hotel",
  resource: "standard-502",
  idempotencyKey: "walk-h1",
  correlationId: corr,
});
platform.reservations.confirm(hold.reservation.reservation_id, corr);
const qr1 = platform.reservations.issueCredential(hold.reservation.reservation_id, corr);
console.log("首张二维码：", qr1.token, "占用版本：", qr1.occupancy_version);

// 3) 外卡充值：重复回调绝不二次扣款。
line("3. 外卡充值：支付网络回调重投三次，只扣款一次");
const topup = platform.payments.initiate({
  sessionId: session.session_id,
  service: "wallet:topup",
  clientPaymentId: "WALK-TOPUP-1",
  amount: 500,
  currency: "CNY",
  topUp: true,
  correlationId: corr,
});
for (let i = 0; i < 3; i += 1) {
  const r = platform.payments.handleCallback({
    paymentId: topup.payment.payment_id,
    callbackId: "CB-1",
    outcome: "captured",
    correlationId: corr,
  });
  console.log(`第 ${i + 1} 次回调：`, r.deduped ? "去重回放（未扣款）" : "首次入账");
}

// 4) 行程：确认后锚点冻结；换酒店产生新二维码，旧码立即失效。
line("4. 行程版本与换订：已确认住宿不能静默替换");
const v1 = platform.itinerary.propose({
  sessionId: session.session_id,
  correlationId: corr,
  changeNote: "首日入住珍珠酒店",
  items: [
    {
      item_id: "hotel-1",
      type: "lodging",
      provider: "hotel",
      reservation_id: hold.reservation.reservation_id,
      detail: { hotel: "珍珠酒店", room: "502" },
    },
  ],
});
platform.itinerary.confirm(v1.revision_id, corr, (id) => platform.reservations.get(id));
try {
  platform.itinerary.propose({
    sessionId: session.session_id,
    correlationId: corr,
    changeNote: "价格变动，平台想悄悄换成江景酒店",
    items: [{ item_id: "hotel-1", type: "lodging", provider: "hotel", reservation_id: "rsv-other", detail: { hotel: "江景" } }],
  });
} catch (err) {
  console.log("静默替换被拦截：", err.code);
}
const rebooked = platform.reservations.rebook({
  oldReservationId: hold.reservation.reservation_id,
  newService: "hotel:riverside",
  newResource: "river-view-1201",
  idempotencyKey: "walk-h2",
  correlationId: corr,
});
console.log("旧码核销：", platform.reservations.verifyCredential(qr1.token));
console.log("新码核销：", platform.reservations.verifyCredential(rebooked.credential.token).ok, "占用版本：", rebooked.credential.occupancy_version);

// 5) 拍照翻译：过敏原 + 低置信度 + 人工更正。
line("5. 拍照翻译：保留来源、置信度、过敏原与人工更正");
const trl = platform.translation.request({
  sessionId: session.session_id,
  correlationId: corr,
  image: Buffer.from(JSON.stringify({
    text: "Shrimp dumplings 虾饺, contains shrimp 虾 and peanut oil 花生油",
    translation: "虾饺：含虾、花生油",
    confidence: 0.66,
  })),
  source: { channel: "visitor-app-ios" },
});
console.log("过敏原：", trl.allergen_flags, "低置信度警示：", trl.low_confidence_warning);
platform.translation.correct({
  translationId: trl.translation_id,
  correctedBy: "游客本人（对照菜单确认）",
  toText: "虾饺（含虾，烹饪使用花生油）",
});
console.log("更正记录数：", platform.translation.get(trl.translation_id).corrections.length);

// 6) 退税：资格是布尔断言，材料密封留档。
line("6. 退税准备：只凭资格断言，材料密封留档");
platform.sessions.grant({
  sessionId: session.session_id,
  service: "tax_refund",
  purposes: ["退税办理"],
  scopes: [AssertionScope.TaxRefundEligibility],
});
const eligible = platform.assertions.issue({
  sealedRef: session.sealed_ref,
  sessionId: session.session_id,
  service: "tax_refund",
  purpose: "退税办理",
  scope: AssertionScope.TaxRefundEligibility,
  authorized: true,
});
const pack = platform.taxRefund.collect({
  sessionId: session.session_id,
  correlationId: corr,
  eligible: eligible.result,
  authorized: true,
  documents: [{ name: "退税单.pdf", content: { invoice: "INV-2026-001", amount: 1200 } }],
});
console.log("退税资格：", eligible.result, "材料包：", pack.pack_id, "法定留档：", pack.legal_hold);

// 7) 跨服务超时补偿（示意：再加一个会超时的编排）。
line("7. 超时补偿：支付通道重试耗尽，自动释放占位，可恢复续跑");
const { correlationId: corr2 } = platform.orchestration.define({
  sessionId: session.session_id,
  flowName: "加订景点票（演示超时）",
  steps: [
    {
      name: "占用景点名额",
      provider: "attraction",
      action: async () => "ticket-held",
      compensate: async () => console.log("补偿：释放景点名额"),
    },
    {
      name: "外卡支付网络扣款",
      provider: "payment_network",
      action: async () => {
        throw new RetryableError("网关超时", { timeout: true });
      },
      recoveryHint: "可稍后在订单页重试；若已扣款平台自动核对退款",
    },
  ],
});
const inst = await platform.orchestration.run(corr2, {});
console.log("编排结果：", inst.phase, "支付步骤尝试：", `${inst.steps[1].attempt}/${inst.steps[1].max_attempts}`);

// 8) 游客撤回退税授权：后续报送被阻断，已留档材料保留。
line("8. 游客撤回授权：只阻断后续用途");
const auth = platform.sessions.listAuthorizations(session.session_id).find((a) => a.service === "tax_refund");
platform.revokeAuthorization({ authorizationId: auth.authorization_id, reason: "离境前关闭退税用途" });
try {
  platform.taxRefund.submit(pack.pack_id);
} catch (err) {
  console.log("报送结果：", err.message);
}
console.log("材料仍在（法定留档）：", platform.taxRefund.listBySession(session.session_id)[0].legal_hold);

// 9) 双端视图。
line("9. 游客视图（节选）");
const dash = platform.views.travelerDashboard(session.session_id);
for (const f of dash.编排) {
  console.log(`流程「${f.流程}」阶段：${f.阶段}`);
  for (const s of f.步骤) console.log(`  - ${s.事项}｜${s.处理方}｜${s.状态}${s.后续怎么办 ? `｜失败后：${s.后续怎么办}` : ""}`);
}

line("10. 运维追踪视图（脱敏，节选）");
const opsMain = platform.views.opsTrace(corr);
console.log("主链路事件数：", opsMain.统计.事件数, "回调去重：", opsMain.统计.回调去重);
const opsSaga = platform.views.opsTrace(corr2);
console.log("补偿链路补偿事件：", opsSaga.统计.补偿事件, "重试失败事件：", opsSaga.统计.重试事件);
console.log(opsMain.脱敏声明);
