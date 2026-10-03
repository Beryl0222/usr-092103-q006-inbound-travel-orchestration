import { AggregateType, EventType } from "../domain.ts";
import { DomainError, fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

/**
 * 可恢复故障：跨系统调用超时或结果未知。
 * 与“确定被拒绝”（DomainError 其他 code）区分：后者不重试，直接进入补偿。
 */
export class RecoverableError extends DomainError {
  constructor(message, details = {}) {
    super("RECOVERABLE", message, details);
    this.name = "RecoverableError";
  }
}

/**
 * Saga 编排引擎。
 *
 * 消息边界：每个步骤是 orchestration_step 聚合，状态迁移全部事件化，
 * correlation_id 贯穿整条链，运维侧可跨服务还原故障现场。
 *
 * 重试异构性：attempt 上限、退避取自被调服务方注册表的 retryPolicy，
 * 而不是全局统一值。超时/未知结果挂起（STEP_SUSPENDED），到点 tick 恢复，
 * 或人工/对账通过 recover(flowId) 用 probe 判定远端真实状态后继续——
 * 不凭猜测重发扣款/占位请求。
 *
 * 补偿：步骤耗尽重试或确定失败时，已成功步骤按反序补偿；
 * 扣款类补偿（退款）与占位类补偿（取消）自身幂等，重复触发不产生第二次副作用。
 */
export class OrchestrationEngine {
  #store;
  #clock;
  #registry;
  #flows = new Map(); // flowId -> 投影
  #definitions = new Map();
  #startKeys = new Map();

  constructor({ store, clock, registry }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    store.subscribe((e) => this.#apply(e));
  }

  defineFlow(definition) {
    if (!definition.flowType || !Array.isArray(definition.steps) || definition.steps.length === 0)
      fail("BAD_FLOW_DEFINITION", "流程定义需要 flowType 与至少一个步骤");
    for (const s of definition.steps) {
      if (!s.key || typeof s.run !== "function") fail("BAD_STEP", `步骤定义非法：${s.key ?? "?"}`);
      // partyId 可以是静态值，也可以是按流程输入解析的函数（如酒店由输入决定）。
      if (typeof s.partyId === "string") this.#registry.get(s.partyId);
      else if (typeof s.partyId !== "function") fail("BAD_STEP", `步骤 ${s.key} 缺少 partyId`);
    }
    this.#definitions.set(definition.flowType, definition);
    return definition;
  }

  #apply(event) {
    if (event.aggregate_type !== AggregateType.OrchestrationStep) return;
    const flowId = event.correlation_id;
    const flow = this.#flows.get(flowId) ?? {
      id: flowId,
      steps: new Map(),
      status: "running",
      startedAt: event.occurred_at,
    };
    const p = event.payload ?? {};
    const step = flow.steps.get(p.step_key) ?? { key: p.step_key, attempts: 0, compensations: 0 };
    step.partyId = p.party_id;
    step.partyName = p.party_name;
    step.label = p.label ?? step.label;
    switch (event.event_type) {
      case EventType.StepEnqueued:
        step.status = "enqueued";
        flow.steps.set(p.step_key, step);
        break;
      case EventType.StepStarted:
      case EventType.StepResumed:
        step.status = "running";
        step.attempts += 1; // 恢复执行也是一次新尝试
        step.lastAttemptAt = event.occurred_at;
        break;
      case EventType.StepRetryScheduled:
        step.status = "suspended";
        step.notBefore = p.not_before;
        step.lastError = p.error_code;
        break;
      case EventType.StepSuspended:
        step.status = "suspended";
        step.suspendReason = p.reason;
        step.notBefore = p.not_before ?? step.notBefore;
        step.awaitReconciliation = p.reason === "await_reconciliation";
        break;
      case EventType.StepSucceeded:
        step.status = "succeeded";
        step.resultRef = p.result_ref;
        step.succeededAt = event.occurred_at;
        flow.results ??= {};
        flow.results[step.key] = p.result_ref;
        break;
      case EventType.StepFailed:
        step.status = "failed";
        step.lastError = p.error_code;
        step.errorMessage = p.message;
        flow.status = "compensating";
        break;
      case EventType.CompensationStarted:
        step.status = "compensating";
        step.compensations += 1;
        break;
      case EventType.CompensationCompleted:
        step.status = "compensated";
        step.compensationResult = p.result_ref;
        break;
      default:
    }
    flow.steps.set(p.step_key, step);
    this.#flows.set(flowId, flow);
  }

  /** 启动流程。startKey 用于入口防重（游客双击/网关重发只产生一条编排链）。 */
  start(flowType, { sessionId, input, startKey, label }) {
    const def = this.#definitions.get(flowType);
    if (!def) fail("FLOW_NOT_DEFINED", `未定义流程：${flowType}`);
    if (startKey) {
      const dedupeKey = `${flowType}:${startKey}`;
      if (this.#startKeys.has(dedupeKey)) return this.getFlow(this.#startKeys.get(dedupeKey));
      const flowId = newId("flow");
      this.#startKeys.set(dedupeKey, flowId);
      return this.#instantiate(def, { sessionId, input, flowId, label });
    }
    return this.#instantiate(def, { sessionId, input, flowId: newId("flow"), label });
  }

  #instantiate(def, { sessionId, input, flowId, label }) {
    this.#flows.set(flowId, {
      id: flowId,
      flowType: def.flowType,
      sessionId,
      input,
      label: label ?? def.label ?? def.flowType,
      steps: new Map(),
      results: {},
      status: "running",
      cursor: 0,
    });
    this.#advance(flowId);
    return this.getFlow(flowId);
  }

  #getFlowOrFail(flowId) {
    const flow = this.#flows.get(flowId);
    if (!flow) fail("FLOW_NOT_FOUND", `编排链不存在：${flowId}`);
    return flow;
  }

  #appendStepEvent(flow, step, eventType, version, payload, extra = {}) {
    const party = this.#registry.get(step.partyId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: eventType,
        aggregate_type: AggregateType.OrchestrationStep,
        aggregate_id: step.aggregateId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: payload.summary,
        correlation_id: flow.id,
        payload: {
          step_key: step.key,
          session_id: flow.sessionId,
          party_id: step.partyId,
          party_name: party.name,
          label: step.label,
          ...payload,
        },
        ...extra,
      },
      version,
    );
  }

  #advance(flowId) {
    const flow = this.#getFlowOrFail(flowId);
    const def = this.#definitions.get(flow.flowType);
    while (flow.status === "running" && flow.cursor < def.steps.length) {
      const stepDef = def.steps[flow.cursor];
      const outcome = this.#attempt(flow, stepDef);
      if (outcome === "suspended") return; // 等 tick/recover
      if (outcome === "failed") {
        flow.status = "compensating";
        this.#compensate(flowId);
        return;
      }
      flow.cursor += 1;
    }
    if (flow.status === "running" && flow.cursor >= def.steps.length) flow.status = "completed";
  }

  #resolvePartyId(stepDef, ctx) {
    const partyId = typeof stepDef.partyId === "function" ? stepDef.partyId(ctx) : stepDef.partyId;
    this.#registry.get(partyId); // 运行时再次确认服务方已登记
    return partyId;
  }

  #ensureStepAggregate(flow, stepDef, ctx) {
    let step = flow.steps.get(stepDef.key);
    if (!step) {
      step = {
        key: stepDef.key,
        partyId: this.#resolvePartyId(stepDef, ctx),
        label: stepDef.label ?? stepDef.key,
        aggregateId: newId("step"),
        attempts: 0,
        compensations: 0,
      };
      flow.steps.set(stepDef.key, step);
      const party = this.#registry.get(step.partyId);
      this.#appendStepEvent(flow, step, EventType.StepEnqueued, 0, {
        summary: `步骤入队：${step.label}（处理方：${party.name}）`,
      });
    }
    return step;
  }

  #attempt(flow, stepDef, { isResume = false } = {}) {
    const ctx0 = { sessionId: flow.sessionId, input: flow.input, results: flow.results };
    const step = this.#ensureStepAggregate(flow, stepDef, ctx0);
    const party = this.#registry.get(step.partyId);
    let version = this.#store.versionOf(AggregateType.OrchestrationStep, step.aggregateId);
    this.#appendStepEvent(
      flow,
      step,
      isResume ? EventType.StepResumed : EventType.StepStarted,
      version,
      { summary: isResume ? `对账后恢复步骤：${step.label}` : `开始执行：${step.label}` },
    );
    version += 1;

    const ctx = {
      flowId: flow.id,
      sessionId: flow.sessionId,
      input: flow.input,
      results: flow.results,
      attempt: step.attempts,
      // 幂等键在同一流程同一步骤上稳定：重试/超时重发都复用，占位与扣款不会重复。
      idemKey: `${flow.id}:${step.key}`,
    };

    let result;
    try {
      result = stepDef.run(ctx);
      // 远端调用成功后再做本地入账（applyResult）。
      // 两者分离使得“回执丢失”时本地可以尚未入账，待对账 committed 后以同一回调编号幂等落地。
      if (typeof stepDef.applyResult === "function") result = stepDef.applyResult(ctx, result);
    } catch (error) {
      if (error instanceof RecoverableError) {
        const policy = party.retryPolicy;
        // 回执丢失：副作用可能已发生，绝不盲目重发——挂起等待 recover(probe) 对账。
        if (error.sideEffectPossible) {
          const notBefore = new Date(
            this.#clock.epochMs() + policy.backoffBaseMs * 4,
          ).toISOString();
          this.#appendStepEvent(flow, step, EventType.StepSuspended, version, {
            error_code: error.code,
            message: error.message,
            reason: "await_reconciliation",
            not_before: notBefore,
            summary: `「${party.name}」回执丢失、结果未知，挂起等待对账恢复（禁止自动重发，防止重复扣款/占位）`,
          });
          step.notBefore = notBefore;
          step.awaitReconciliation = true;
          return "suspended";
        }
        if (step.attempts < policy.maxAttempts) {
          const waitMs = policy.backoffBaseMs * 2 ** (step.attempts - 1);
          const notBefore = new Date(this.#clock.epochMs() + waitMs).toISOString();
          this.#appendStepEvent(flow, step, EventType.StepRetryScheduled, version, {
            error_code: error.code,
            message: error.message,
            attempt: step.attempts,
            max_attempts: policy.maxAttempts,
            not_before: notBefore,
            summary: `「${party.name}」超时/结果未知，第 ${step.attempts}/${policy.maxAttempts} 次尝试挂起，${waitMs}ms 后可恢复`,
          });
          step.notBefore = notBefore;
          return "suspended";
        }
        this.#appendStepEvent(flow, step, EventType.StepFailed, version, {
          error_code: error.code,
          message: error.message,
          attempt: step.attempts,
          summary: `「${party.name}」重试 ${policy.maxAttempts} 次仍无结果，步骤失败，进入补偿`,
        });
        flow.failedStep = step.key;
        return "failed";
      }
      // 确定失败（满房、拒卡、资格不符等业务拒绝）：不重试，立即补偿。
      this.#appendStepEvent(flow, step, EventType.StepFailed, version, {
        error_code: error.code ?? "BUSINESS_REJECTED",
        message: error.message,
        attempt: step.attempts,
        retriable: false,
        summary: `步骤失败（不可重试）：${step.label} —— ${error.message}`,
      });
      flow.failedStep = step.key;
      return "failed";
    }

    this.#appendStepEvent(flow, step, EventType.StepSucceeded, version, {
      result_ref: resultRefOf(result),
      summary: `步骤完成：${step.label}（处理方：${party.name}）`,
    });
    flow.results[step.key] = result;
    return "succeeded";
  }

  /** 时钟到点：恢复所有 not_before 已过的挂起步骤。 */
  tick() {
    const resumed = [];
    for (const flow of this.#flows.values()) {
      if (flow.status !== "running") continue;
      const def = this.#definitions.get(flow.flowType);
      const stepDef = def.steps[flow.cursor];
      const step = flow.steps.get(stepDef?.key);
      // awaitReconciliation 的步骤只能由 recover(probe) 恢复，tick 不得自动重发。
      if (
        step?.status === "suspended" &&
        !step.awaitReconciliation &&
        Date.parse(step.notBefore) <= this.#clock.epochMs()
      ) {
        const outcome = this.#attempt(flow, stepDef, { isResume: true });
        if (outcome === "suspended") continue;
        if (outcome === "failed") {
          flow.status = "compensating";
          this.#compensate(flow.id);
          continue;
        }
        flow.cursor += 1;
        this.#advance(flow.id);
        resumed.push(flow.id);
      }
    }
    return resumed;
  }

  /**
   * 人工/对账恢复：用步骤定义的 probe 询问远端真实状态。
   * - committed：远端实际已成功 → 本地补齐成功并继续（不会再发一次请求）；
   * - absent：远端无此单 → 重新执行；
   * - unknown：证据不足，继续挂起等待下一轮对账。
   */
  recover(flowId) {
    const flow = this.#getFlowOrFail(flowId);
    const def = this.#definitions.get(flow.flowType);
    const stepDef = def.steps[flow.cursor];
    const step = flow.steps.get(stepDef.key);
    if (step?.status !== "suspended") fail("STEP_NOT_SUSPENDED", "当前没有挂起步骤需要恢复");
    const ctx = {
      flowId: flow.id,
      sessionId: flow.sessionId,
      input: flow.input,
      results: flow.results,
      idemKey: `${flow.id}:${step.key}`,
    };
    if (typeof stepDef.probe !== "function") {
      // 无探针：人工恢复即立即重试（仍复用同一幂等键，远端若实际已受理会被对端去重挡住）。
      const outcome = this.#attempt(flow, stepDef, { isResume: true });
      if (outcome === "failed") {
        flow.status = "compensating";
        this.#compensate(flow.id);
      } else if (outcome === "succeeded") {
        flow.cursor += 1;
        this.#advance(flow.id);
      }
      return this.getFlow(flowId);
    }
    const rawVerdict = stepDef.probe(ctx);
    const verdict = typeof rawVerdict === "string" ? rawVerdict : rawVerdict?.state;
    let version = this.#store.versionOf(AggregateType.OrchestrationStep, step.aggregateId);
    if (verdict !== "committed" && verdict !== "absent" && verdict !== "unknown") {
      fail("BAD_PROBE_VERDICT", `probe 必须返回 committed/absent/unknown，实际：${verdict}`);
    }
    if (verdict === "unknown") {
      const waitMs = this.#registry.get(step.partyId).retryPolicy.backoffBaseMs * 4;
      const notBefore = new Date(this.#clock.epochMs() + waitMs).toISOString();
      this.#appendStepEvent(flow, step, EventType.StepSuspended, version, {
        reason: "probe_unknown",
        not_before: notBefore,
        summary: `对账结果未知：${step.label} 继续挂起，等待下一轮对账`,
      });
      step.notBefore = notBefore;
      return this.getFlow(flowId);
    }
    if (verdict === "committed") {
      // 对端确实受理：用 probe 带回的远端结果做本地入账（回调编号幂等，只落一次）。
      const reconciled =
        typeof stepDef.applyResult === "function"
          ? stepDef.applyResult(ctx, rawVerdict.result)
          : rawVerdict.result ?? { reconciled: true };
      this.#appendStepEvent(flow, step, EventType.StepSucceeded, version, {
        result_ref: resultRefOf(reconciled),
        via_reconciliation: true,
        summary: `对账确认远端已完成：${step.label}，本地补齐状态（不重复发起）`,
      });
      flow.results[step.key] = reconciled;
      flow.cursor += 1;
      this.#advance(flow.id);
      return this.getFlow(flowId);
    }
    // absent：重新执行（#attempt 内部会记录恢复事件）。
    const outcome = this.#attempt(flow, stepDef, { isResume: true });
    if (outcome === "failed") {
      flow.status = "compensating";
      this.#compensate(flow.id);
    } else if (outcome === "succeeded") {
      flow.cursor += 1;
      this.#advance(flow.id);
    }
    return this.getFlow(flowId);
  }

  #compensate(flowId) {
    const flow = this.#getFlowOrFail(flowId);
    const def = this.#definitions.get(flow.flowType);
    flow.status = "compensating";
    for (let i = flow.cursor; i >= 0; i--) {
      const stepDef = def.steps[i];
      const step = flow.steps.get(stepDef.key);
      if (!step || step.status !== "succeeded" || typeof stepDef.compensate !== "function") continue;
      let version = this.#store.versionOf(AggregateType.OrchestrationStep, step.aggregateId);
      this.#appendStepEvent(flow, step, EventType.CompensationStarted, version, {
        summary: `开始反向补偿：${step.label}（处理方：${this.#registry.get(step.partyId).name}）`,
      });
      version += 1;
      const ctx = {
        flowId: flow.id,
        sessionId: flow.sessionId,
        input: flow.input,
        results: flow.results,
        // 补偿幂等键同样稳定：补偿流程本身被重复触发时不会退两次款/取消两次。
        idemKey: `${flow.id}:${step.key}:compensate`,
      };
      const compensationResult = stepDef.compensate(ctx, flow.results[step.key]);
      this.#appendStepEvent(flow, step, EventType.CompensationCompleted, version, {
        result_ref: resultRefOf(compensationResult),
        summary: `补偿完成：${step.label}`,
      });
    }
    flow.status = "compensated";
    return this.getFlow(flowId);
  }

  getFlow(flowId) {
    const flow = this.#getFlowOrFail(flowId);
    return {
      id: flow.id,
      flowType: flow.flowType,
      sessionId: flow.sessionId,
      label: flow.label,
      status: flow.status,
      cursor: flow.cursor,
      failedStep: flow.failedStep ?? null,
      steps: [...flow.steps.values()].map((s) => ({ ...s })),
    };
  }

  /** 游客视图：每一步谁处理、什么状态、失败后怎么继续；不含技术细节与身份资料。 */
  travelerView(flowId) {
    const flow = this.getFlow(flowId);
    return {
      flow_id: flow.id,
      label: flow.label,
      statusLabel: FLOW_STATUS_LABEL[flow.status],
      status: flow.status,
      steps: flow.steps.map((s) => ({
        label: s.label,
        handled_by: s.partyName,
        state: s.status,
        stateLabel: STEP_STATUS_LABEL[s.status] ?? s.status,
        attempts: s.attempts,
        next_action: travelerNextAction(s, flow.status),
      })),
    };
  }
}

function resultRefOf(result) {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const ref = result.id ?? result.reservationId ?? result.paymentId ?? result.ref;
    return ref ? String(ref) : "result";
  }
  return String(result);
}

const FLOW_STATUS_LABEL = {
  running: "处理中",
  completed: "全部完成",
  compensating: "出现问题，正在回退已办理的事项",
  compensated: "未能完成，已办理事项已回退",
};

const STEP_STATUS_LABEL = {
  enqueued: "排队中",
  running: "处理中",
  suspended: "等待对方系统恢复后自动继续",
  succeeded: "已完成",
  failed: "失败",
  compensating: "正在撤销",
  compensated: "已撤销",
};

function travelerNextAction(step, flowStatus) {
  switch (step.status) {
    case "suspended":
      return step.awaitReconciliation
        ? "对方系统回应超时，平台正在核对该笔交易是否已实际受理，确认后自动继续，不会重复扣款"
        : `请稍候，平台将自动重试；也可要求“立即重试/联系人工”（预计 ${step.notBefore} 后恢复）`;
    case "failed":
      return flowStatus === "compensated"
        ? "该项未能办理，相关扣款会原路退回，请更换选择后重新发起"
        : "正在处理，请等待回退完成";
    case "compensating":
      return "正在撤销，请稍候";
    case "compensated":
      return "已撤销，如已扣款将原路退回";
    default:
      return null;
  }
}
