import { policyOf } from "./policies.js";

/**
 * 双端只读视图。两者都从同一份事件流与领域状态派生，但可见字段不同：
 *  - 游客视图：每一步由谁处理、当前状态、失败后如何继续、授权清单、可用凭证、行程版本差异；
 *  - 运维视图：按 correlation_id 的跨服务故障时间线，只含服务方/步骤/错误/次数，
 *    不含护照号、姓名、出生日期、图片哈希以外的身份资料（图片哈希也不在追踪视图中呈现）。
 */
export class Views {
  constructor(services) {
    this.s = services;
  }

  /** 游客视角：我走到哪一步了、谁在办、失败了怎么办。 */
  travelerDashboard(sessionId) {
    const session = this.s.sessions.getSession(sessionId);
    if (!session) throw new Error("会话不存在");

    const flows = this.#flowsOf(sessionId).map((inst) => ({
      流程: inst.flow_name,
      阶段: phaseLabel(inst.phase),
      步骤: inst.steps.map((st) => ({
        事项: st.name,
        处理方: policyOf(st.provider).label,
        状态: stepLabel(st.status),
        尝试: `${st.attempt}/${st.max_attempts}`,
        失败原因: st.status === "succeeded" ? undefined : st.last_error,
        后续怎么办: ["failed_retryable", "compensating", "failed_terminal"].includes(st.status)
          ? st.recovery_hint
          : undefined,
      })),
    }));

    return {
      会话: {
        会话号: session.session_id,
        状态: session.status,
        开始时间: session.started_at,
        护照原件: "已密封保管，商户不可见",
      },
      授权: this.s.sessions.listAuthorizations(sessionId).map((a) => ({
        服务方: a.service,
        用途: a.purposes,
        范围: a.scopes,
        状态: a.status === "active" ? "有效" : `已撤回（${a.revoke_reason ?? "游客撤回"}）`,
        授权时间: a.granted_at,
        撤回时间: a.revoked_at,
        说明:
          a.status === "revoked"
            ? "撤回只阻止之后的使用；撤回前已完成交易的法定留档不受影响"
            : undefined,
      })),
      身份断言: this.s.assertions.listFor(sessionId).map((a) => ({
        提供给: a.service,
        断言: assertionLabel(a.scope),
        结果: typeof a.result === "object" ? "资格通过（回执）" : a.result,
        状态: a.status === "valid" ? "有效" : "已随授权撤回失效",
      })),
      预订与凭证: this.s.reservations.listBySession(sessionId).map((r) => {
        const cred = Object.values(this.s.reservations.credentials)
          .filter((c) => c.session_id === sessionId)
          .map((c) => ({ 凭证号: c.credential_id, 状态: credentialLabel(c.status) }));
        return {
          预订: r.reservation_id,
          服务方: policyOf(r.provider).label,
          资源: r.resource,
          状态: reservationLabel(r.status),
          占用版本: r.occupancy_version,
          法定留档: r.legal_hold ? "是（换订/撤回不删除）" : "否",
          取代: r.supersedes,
          凭证: cred,
        };
      }),
      行程版本: this.s.itinerary.list(sessionId).map((rev) => ({
        版本: rev.revision_no,
        性质: rev.kind === "confirmation" ? "已确认" : "提案",
        说明: rev.change_note,
        锚点已冻结: rev.anchors_frozen,
        条目数: rev.items.length,
      })),
      支付: [...this.s.payments.payments.values()]
        .filter((p) => p.session_id === sessionId)
        .map((p) => ({
          支付号: p.payment_id,
          类型: p.top_up ? "外卡充值" : "消费支付",
          金额: `${p.amount} ${p.currency}`,
          状态: paymentLabel(p.status),
          收款方: p.service,
        })),
      翻译: this.s.translation.listBySession(sessionId).map((t) => ({
        编号: t.translation_id,
        原图来源: `${t.source.channel} @ ${t.source.captured_at}`,
        置信度: `${(t.confidence * 100).toFixed(0)}%`,
        过敏原: t.allergen_flags,
        低置信度警示: t.low_confidence_warning,
        当前译文: t.translated_text,
        人工更正: t.corrections.map((c) => ({ 更正人: c.corrected_by, 时间: c.at, 由: c.from_text, 改为: c.to_text })),
      })),
      退税: this.s.taxRefund.listBySession(sessionId).map((p) => ({
        材料包: p.pack_id,
        就绪: p.ready,
        已报送: Boolean(p.submitted),
        后续用途: p.further_use_blocked ? "已阻断（授权撤回），已留档材料依法保留" : "正常",
      })),
      编排: flows,
    };
  }

  /**
   * 运维视角：跨服务故障追踪。脱敏——只输出故障定位所需元数据。
   * 任何护照原件、断言详细结果、原图内容都不会出现。
   */
  opsTrace(correlationId) {
    const events = this.s.store.traceByCorrelation(correlationId);
    if (!events.length) throw new Error("找不到该追踪标识的事件");

    const deniedAccess = this.#deniedAuditEntries(correlationId);
    return {
      追踪号: correlationId,
      事件时间线: events.map((e) => ({
        时间: e.occurred_at,
        事件: e.event_type,
        聚合: e.aggregate_type,
        处理方: e.service_provider ? policyOf(e.service_provider).label : undefined,
        因果: e.causation_id,
        // summary 是运维写好的中文排障描述，不含身份字段；payload 整体不下发。
        摘要: e.summary,
      })),
      失败步骤: this.#failedSteps(correlationId),
      被拒绝的身份访问: deniedAccess,
      统计: {
        事件数: events.length,
        重试事件: events.filter((e) => e.event_type === "STEP_FAILED").length,
        补偿事件: events.filter((e) =>
          ["COMPENSATION_STARTED", "COMPENSATION_RESUMED", "COMPENSATION_COMPLETED"].includes(e.event_type),
        ).length,
        回调去重: events.filter((e) => e.event_type === "CALLBACK_DEDUPED").length,
      },
      脱敏声明: "本视图不含护照号、姓名、出生日期、证件影像或翻译原图",
    };
  }

  #flowsOf(sessionId) {
    return [...this.s.orchestration.instances.values()].filter((i) => i.session_id === sessionId);
  }

  #failedSteps(correlationId) {
    const inst = this.s.orchestration.get(correlationId);
    if (!inst) return [];
    return inst.steps
      .filter((s) => ["failed_retryable", "compensating", "failed_terminal"].includes(s.status))
      .map((s) => ({
        步骤: s.name,
        处理方: policyOf(s.provider).label,
        尝试: `${s.attempt}/${s.max_attempts}`,
        错误: s.last_error,
      }));
  }

  #deniedAuditEntries(correlationId) {
    // 由追踪号找到会话，再汇总该会话所有密封件的拒绝记录（不含原件内容）。
    const sessions = [...this.s.sessions.sessions.values()];
    const session = sessions.find((s) => s.correlation_id === correlationId);
    if (!session) return [];
    const out = [];
    for (const seal of this.s.vault.seals.values()) {
      if (seal.session_id !== session.session_id) continue;
      for (const a of seal.audit.filter((x) => !x.allowed)) {
        out.push({ 时间: a.at, 访问方: a.service, 用途: a.purpose, 拒绝原因: a.reason });
      }
    }
    return out;
  }
}

function phaseLabel(p) {
  return {
    defined: "已建立",
    running: "办理中",
    compensating: "补偿中（可恢复）",
    completed: "已完成",
    compensated: "已补偿回退",
  }[p] ?? p;
}
function stepLabel(s) {
  return {
    pending: "待处理",
    running: "处理中",
    succeeded: "已完成",
    failed_retryable: "失败（可重试/接续）",
    compensating: "补偿中",
    compensated: "已回退",
    failed_terminal: "终态失败",
  }[s] ?? s;
}
function reservationLabel(s) {
  return { held: "占用中", confirmed: "已确认", released: "已释放", compensating: "补偿中" }[s] ?? s;
}
function credentialLabel(s) {
  return { active: "有效", rotated: "已换订轮换失效", revoked: "已撤销" }[s] ?? s;
}
function paymentLabel(s) {
  return { initiated: "待入账", captured: "已扣款", failed: "失败", refunded: "已退款" }[s] ?? s;
}
function assertionLabel(s) {
  return (
    {
      entry_eligibility: "入境资格（是/否）",
      adult_status: "成年资格（是/否）",
      hotel_registration_alias: "入住登记化名",
      tax_refund_eligibility: "退税资格（是/否）",
      payment_kyc_receipt: "支付实名回执",
    }[s] ?? s
  );
}
