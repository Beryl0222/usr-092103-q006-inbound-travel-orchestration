import { RecoverableError } from "../orchestration/orchestrator.js";

/**
 * Saga 流程登记。
 * 每个步骤声明：处理方 partyId（其重试策略来自注册表）、run、可选 probe（对账）与 compensate。
 * 步骤内所有跨系统调用都带稳定幂等键（ctx.idemKey），超时重发与对账恢复都不会重复扣款/占位。
 */
export function registerFlows({ orchestrator, services, network, registry, clock }) {
  const { identity, authorization, reservations, payments, translations, taxRefund } = services;

  /** 已完成交易的法定留档期：取交易相关方法定义务中的最长留存天数。 */
  function legalRetainUntil(partyIds) {
    const days = Math.max(...partyIds.map((id) => registry.get(id).retentionPolicy.days));
    return new Date(clock.epochMs() + days * 24 * 3600 * 1000).toISOString();
  }

  /** 支付+预订终态后登记法定留档；授权事后撤回不影响这些记录。 */
  function holdBookingRecord(ctx, reservationId, paymentId = null) {
    if (!ctx.input.auth_id) return;
    authorization.holdLegalRecord(ctx.input.auth_id, {
      transactionRef: reservationId,
      partyId: ctx.input.hotel_party_id,
      scope: "lodging_checkin",
      retainUntil: legalRetainUntil([ctx.input.hotel_party_id, "acquirer-globalpay"]),
      reason: "入境住宿登记与支付留档",
    });
    if (paymentId) {
      authorization.holdLegalRecord(ctx.input.auth_id, {
        transactionRef: paymentId,
        partyId: "acquirer-globalpay",
        scope: "lodging_checkin",
        retainUntil: legalRetainUntil(["acquirer-globalpay"]),
        reason: "房费支付留档",
      });
    }
  }


  // —— 酒店预订+入住：最小断言 → 占位 → 外卡支付 → 确认发码 ——
  orchestrator.defineFlow({
    flowType: "hotel_booking",
    label: "酒店预订与入住",
    steps: [
      {
        key: "assert_identity",
        partyId: (ctx) => ctx.input.hotel_party_id,
        label: "向酒店提供入住所需的最小身份信息",
        run: (ctx) =>
          identity.issueAssertion({
            vaultId: ctx.input.vault_id,
            partyId: ctx.input.hotel_party_id,
            purpose: "lodging_checkin",
          }),
      },
      {
        key: "reserve_room",
        partyId: (ctx) => ctx.input.hotel_party_id,
        label: "锁定客房名额",
        run: (ctx) =>
          network.call(ctx.input.hotel_party_id, "预订占位", ctx.idemKey, () =>
            reservations.request({
              sessionId: ctx.sessionId,
              partyId: ctx.input.hotel_party_id,
              resourceId: ctx.input.resource_id,
              date: ctx.input.date,
              idempotencyKey: ctx.idemKey,
            }),
          ),
        probe: (ctx) => network.probe(ctx.idemKey),
        compensate: (_ctx, result) => reservations.cancel(result.id, "编排补偿：释放客房占位"),
      },
      {
        key: "charge_card",
        partyId: () => "acquirer-globalpay",
        label: "外卡支付房费",
        // run 只发起扣款（pending）；PAYMENT_SUCCEEDED 在 applyResult 收到回执/对账确认后才入账。
        run: (ctx) =>
          network.call("acquirer-globalpay", "外卡扣款", ctx.idemKey, () =>
            payments.initiate({
              sessionId: ctx.sessionId,
              partyId: "acquirer-globalpay",
              purpose: "lodging_charge",
              amount: ctx.input.amount,
              currency: ctx.input.currency,
              refType: "reservation",
              refId: ctx.results.reserve_room.id,
              idempotencyKey: ctx.idemKey,
            }),
          ),
        // 回调编号稳定：正常回执与对账恢复走同一条幂等路径，只可能成功一次。
        applyResult: (ctx, pending) =>
          payments.resultCallback("acquirer-globalpay", {
            callbackId: ctx.idemKey + ":cb",
            paymentId: pending.id,
            outcome: "succeeded",
            gatewayRef: "gw-" + ctx.idemKey,
          }),
        probe: (ctx) => network.probe(ctx.idemKey),
        compensate: (ctx, result) => {
          if (result?.status !== "succeeded") return { skipped: true };
          return payments.refund(result.id, ctx.idemKey + ":refund", "编排补偿：房费原路退回");
        },
      },
      {
        key: "confirm_booking",
        partyId: (ctx) => ctx.input.hotel_party_id,
        label: "酒店确认并发放入住二维码",
        run: (ctx) =>
          network.call(ctx.input.hotel_party_id, "预订确认", ctx.idemKey + ":confirm", () => ({
            reservation_id: ctx.results.reserve_room.id,
          })),
        applyResult: (ctx, remote) => {
          const result = reservations.confirmCallback(ctx.input.hotel_party_id, {
            callbackId: ctx.idemKey + ":confirm:cb",
            reservationId: remote.reservation_id,
            accepted: true,
            reservationRef: ctx.input.reservation_ref,
          });
          holdBookingRecord(ctx, result.id, ctx.results.charge_card?.id);
          return result;
        },
        probe: (ctx) => network.probe(ctx.idemKey + ":confirm"),
        compensate: (ctx) =>
          reservations.cancel(ctx.results.reserve_room.id, "编排补偿：撤销确认，二维码作废"),
      },
    ],
  });

  // —— 酒店换订：先立新后破旧 ——
  // 顺序：新酒店占位 → 差价支付 → 新单确认发码 → 最后才取消旧单/作废旧码。
  // 这样任一新单环节失败时，补偿只回退新侧（释放占位、退差价），旧单原封不动，
  // 游客始终有房可住；旧单取消是幂等操作，即使超时也可靠重试/对账完成。
  orchestrator.defineFlow({
    flowType: "hotel_change",
    label: "酒店换订",
    steps: [
      {
        key: "reserve_new",
        partyId: (ctx) => ctx.input.new_hotel_party_id,
        label: "在新酒店锁定客房",
        run: (ctx) =>
          network.call(ctx.input.new_hotel_party_id, "换订占位", ctx.idemKey, () =>
            reservations.request({
              sessionId: ctx.sessionId,
              partyId: ctx.input.new_hotel_party_id,
              resourceId: ctx.input.new_resource_id,
              date: ctx.input.date,
              idempotencyKey: ctx.idemKey,
            }),
          ),
        probe: (ctx) => network.probe(ctx.idemKey),
        compensate: (_ctx, result) => reservations.cancel(result.id, "换订补偿：释放新酒店占位"),
      },
      {
        key: "charge_diff",
        partyId: () => "acquirer-globalpay",
        label: "支付换订差价",
        run: (ctx) => {
          if (!ctx.input.diff_amount || ctx.input.diff_amount <= 0)
            return { skipped: true, status: "skipped" };
          return network.call("acquirer-globalpay", "差价扣款", ctx.idemKey, () =>
            payments.initiate({
              sessionId: ctx.sessionId,
              partyId: "acquirer-globalpay",
              purpose: "lodging_change_diff",
              amount: ctx.input.diff_amount,
              currency: ctx.input.currency,
              idempotencyKey: ctx.idemKey,
            }),
          );
        },
        applyResult: (ctx, pending) => {
          if (pending?.status === "skipped") return pending;
          return payments.resultCallback("acquirer-globalpay", {
            callbackId: ctx.idemKey + ":cb",
            paymentId: pending.id,
            outcome: "succeeded",
            gatewayRef: "gw-" + ctx.idemKey,
          });
        },
        probe: (ctx) => network.probe(ctx.idemKey),
        compensate: (ctx, result) => {
          if (result?.status !== "succeeded") return { skipped: true };
          return payments.refund(result.id, ctx.idemKey + ":refund", "换订补偿：差价原路退回");
        },
      },
      {
        key: "confirm_new",
        partyId: (ctx) => ctx.input.new_hotel_party_id,
        label: "新酒店确认并发放入住二维码",
        run: (ctx) =>
          network.call(ctx.input.new_hotel_party_id, "换订确认", ctx.idemKey + ":confirm", () => ({
            reservation_id: ctx.results.reserve_new.id,
          })),
        applyResult: (ctx, remote) => {
          const result = reservations.confirmCallback(ctx.input.new_hotel_party_id, {
            callbackId: ctx.idemKey + ":confirm:cb",
            reservationId: remote.reservation_id,
            accepted: true,
            reservationRef: ctx.input.new_reservation_ref,
          });
          if (ctx.input.auth_id) {
            authorization.holdLegalRecord(ctx.input.auth_id, {
              transactionRef: result.id,
              partyId: ctx.input.new_hotel_party_id,
              scope: "lodging_checkin",
              retainUntil: legalRetainUntil([ctx.input.new_hotel_party_id, "acquirer-globalpay"]),
              reason: "换订后新住宿登记留档",
            });
            if (ctx.results.charge_diff?.id && ctx.results.charge_diff.status === "succeeded") {
              authorization.holdLegalRecord(ctx.input.auth_id, {
                transactionRef: ctx.results.charge_diff.id,
                partyId: "acquirer-globalpay",
                scope: "lodging_checkin",
                retainUntil: legalRetainUntil(["acquirer-globalpay"]),
                reason: "换订差价支付留档",
              });
            }
          }
          return result;
        },
        probe: (ctx) => network.probe(ctx.idemKey + ":confirm"),
        compensate: (ctx) =>
          reservations.cancel(ctx.results.reserve_new.id, "换订补偿：撤销新酒店确认"),
      },
      {
        key: "cancel_old",
        partyId: (ctx) => ctx.input.old_hotel_party_id,
        label: "取消原酒店订单并作废原二维码",
        // 放在最后：新单全部就绪才破旧单。取消是幂等终态操作；
        // 若此处明确失败（而非超时挂起），反向补偿会撤销刚建立的新单，整体回到旧单状态。
        run: (ctx) =>
          network.call(ctx.input.old_hotel_party_id, "旧单取消", ctx.idemKey + ":cancel", () =>
            reservations.cancel(ctx.input.old_reservation_id, "游客换订"),
          ),
        probe: (ctx) => network.probe(ctx.idemKey + ":cancel"),
      },
    ],
  });

  // —— 外卡充值（独立入口，同样具备补偿） ——
  orchestrator.defineFlow({
    flowType: "wallet_topup",
    label: "外卡充值",
    steps: [
      {
        key: "topup",
        partyId: () => "acquirer-globalpay",
        label: "外卡充值入账",
        run: (ctx) =>
          network.call("acquirer-globalpay", "充值", ctx.idemKey, () =>
            payments.initiate({
              sessionId: ctx.sessionId,
              partyId: "acquirer-globalpay",
              purpose: "wallet_topup",
              amount: ctx.input.amount,
              currency: ctx.input.currency,
              idempotencyKey: ctx.idemKey,
            }),
          ),
        applyResult: (ctx, pending) =>
          payments.resultCallback("acquirer-globalpay", {
            callbackId: ctx.idemKey + ":cb",
            paymentId: pending.id,
            outcome: "succeeded",
            gatewayRef: "gw-" + ctx.idemKey,
          }),
        probe: (ctx) => network.probe(ctx.idemKey),
        compensate: (ctx, result) => {
          if (result?.status !== "succeeded") return { skipped: true };
          return payments.refund(result.id, ctx.idemKey + ":refund", "充值补偿：原路退回");
        },
      },
    ],
  });

  // —— 菜单拍照翻译：提交原图 → OCR/翻译（原文、置信度、过敏原标记不可变） ——
  orchestrator.defineFlow({
    flowType: "menu_translation",
    label: "菜单拍照翻译",
    steps: [
      {
        key: "submit_image",
        partyId: () => "ocr-translate",
        label: "上传菜单照片并登记原图来源",
        run: (ctx) =>
          translations.submit({
            sessionId: ctx.sessionId,
            partyId: "ocr-translate",
            imageBytes: ctx.input.image_bytes,
            targetLang: ctx.input.target_lang ?? "en",
            context: "menu",
          }),
      },
      {
        key: "run_ocr",
        partyId: () => "ocr-translate",
        label: "识别与翻译菜单内容",
        run: (ctx) => translations.complete(ctx.results.submit_image, { lines: ctx.input.lines }),
      },
    ],
  });

  // —— 退税材料准备（授权 + 一次性护照读取在域内完成） ——
  orchestrator.defineFlow({
    flowType: "tax_refund_prep",
    label: "退税材料准备",
    steps: [
      {
        key: "prepare",
        partyId: () => "tax-agency",
        label: "汇总购物凭证并生成退税材料包",
        run: (ctx) =>
          taxRefund.prepare({
            sessionId: ctx.sessionId,
            vaultId: ctx.input.vault_id,
            authId: ctx.input.auth_id,
            partyId: "tax-agency",
            purchases: ctx.input.purchases,
          }),
      },
    ],
  });
}
