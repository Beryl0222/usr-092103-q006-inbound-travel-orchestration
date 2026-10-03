import { AggregateType } from "../domain.ts";

/**
 * 运维排障视图。
 *
 * 权限边界：运维需要按 correlation_id 还原“哪一步、哪个服务方、什么错误、第几次尝试”，
 * 但无权看到完整身份资料。因此：
 * - identity_vault 事件的 payload 整体折叠，只暴露字段名与授权编号；
 * - 其余事件中的 PII 键（姓名、证件号等）按规则脱敏；
 * - 退税/支付只保留金额与状态，不回传个人字段。
 */

const PII_KEYS = new Set([
  "full_name",
  "passport_number",
  "date_of_birth",
  "card_number",
  "email",
  "phone",
]);

export class TraceView {
  #store;

  constructor({ store }) {
    this.#store = store;
  }

  trace(correlationId) {
    // 编排链事件以 flowId 关联，会话/身份/支付等事件以 sessionId 关联；
    // 从步骤负载中的 session_id 把两段链路接起来，形成完整跨服务时间线。
    const flowEvents = this.#store.trace(correlationId);
    const sessionIds = new Set(
      flowEvents
        .filter((e) => e.aggregate_type === AggregateType.OrchestrationStep && e.payload?.session_id)
        .map((e) => e.payload.session_id),
    );
    const sessionEvents = [...sessionIds].flatMap((id) => this.#store.trace(id));
    const seen = new Set();
    const events = [...flowEvents, ...sessionEvents]
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
      .filter((e) => (seen.has(e.event_id) ? false : seen.add(e.event_id)));
    const steps = new Map();
    const timeline = events.map((e) => {
      const item = {
        event_id: e.event_id,
        at: e.occurred_at,
        event_type: e.event_type,
        aggregate_type: e.aggregate_type,
        aggregate_id: e.aggregate_id,
        summary: e.summary,
        causation_id: e.causation_id ?? null,
        payload: redactPayload(e),
      };
      if (e.aggregate_type === AggregateType.OrchestrationStep && e.payload?.step_key) {
        const s = steps.get(e.payload.step_key) ?? {
          step_key: e.payload.step_key,
          party_id: e.payload.party_id,
          party_name: e.payload.party_name,
          label: e.payload.label,
          events: [],
        };
        s.events.push({ at: e.occurred_at, type: e.event_type, error: e.payload.error_code ?? null });
        steps.set(e.payload.step_key, s);
      }
      return item;
    });

    return {
      correlation_id: correlationId,
      event_count: events.length,
      steps: [...steps.values()].map((s) => ({
        ...s,
        diagnosis: diagnoseStep(s),
      })),
      timeline,
    };
  }
}

function diagnoseStep(step) {
  const types = step.events.map((e) => e.type);
  if (types.includes("STEP_FAILED")) {
    const failed = step.events.find((e) => e.type === "STEP_FAILED");
    return {
      health: "failed",
      error_code: failed.error,
      hint: "步骤终态失败；若已挂起可核对 not_before，确定失败则检查下游补偿是否全部 COMPENSATION_COMPLETED",
    };
  }
  if (types.filter((t) => t === "STEP_RETRY_SCHEDULED").length > 0) {
    return {
      health: "degraded",
      retries: types.filter((t) => t === "STEP_RETRY_SCHEDULED").length,
      hint: "发生跨系统超时/重试；用 recover 的 probe 结论核对远端是否已实际受理，防止重复扣款/占位",
    };
  }
  if (types.includes("STEP_SUSPENDED"))
    return { health: "suspended", hint: "等待对账恢复（probe_unknown 会继续挂起）" };
  if (types.includes("COMPENSATION_COMPLETED")) return { health: "compensated", hint: "补偿已完成" };
  if (types.includes("STEP_SUCCEEDED")) return { health: "ok" };
  return { health: "in_flight" };
}

function redactPayload(event) {
  const p = event.payload;
  if (!p) return null;
  if (event.aggregate_type === AggregateType.IdentityVault) {
    // 身份 vault：只暴露结构与字段名，绝不回传值。
    return {
      _redacted: "identity_vault_payload",
      purpose: p.purpose ?? null,
      party_id: p.party_id ?? null,
      grant_id: p.grant_id ?? null,
      assertion_id: p.assertion_id ?? null,
      fields_included: p.fields_included ?? (p.passport ? Object.keys(p.passport) : []),
      qualification: p.qualification
        ? {
            nationality: p.qualification.nationality, // 国籍不属于敏感个人资料，保留供排障
            visa_type: p.qualification.visa_type,
            visa_valid: p.qualification.visa_valid,
            adult: p.qualification.adult,
          }
        : null,
    };
  }
  return redactValue(p);
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PII_KEYS.has(k)) out[k] = maskKeep(typeof v === "string" ? v : "");
      else out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

function maskKeep(s, keepTail = 2) {
  if (!s) return "***";
  return "***" + (keepTail ? s.slice(-keepTail) : "");
}
