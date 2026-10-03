import { AggregateType, EventType } from "../contracts.js";
import { makeEvent } from "./envelope.js";
import { policyOf } from "./policies.js";

/** 可重试的跨系统故障（含超时）。 */
export class RetryableError extends Error {
  constructor(message, { timeout = false } = {}) {
    super(message);
    this.name = "RetryableError";
    this.code = timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_RETRYABLE";
  }
}

/**
 * Saga 编排引擎。
 *
 * 职责：
 *  - 顺序执行编排步骤，每步采用“该服务方登记”的重试/超时策略（attempt 全程记录）；
 *  - 步骤成功后才推进下一步；某步重试用尽时，不做脏状态停留，
 *    而是启动可恢复的反向补偿（COMPENSATION_STARTED）；
 *  - 补偿动作必须幂等（释放占用、原路退款在各自服务内已幂等），
 *    补偿中途失败可 resumeCompensation 续跑（COMPENSATION_RESUMED），
 *    已完成的补偿不会重复生效；
 *  - 全部步骤/补偿状态写入 orchestration_step 聚合，
 *    游客可见“谁在处理、失败后怎么继续”，运维凭 correlation_id 跨服务追踪。
 */
export class OrchestrationEngine {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    /** correlation_id -> 编排实例 */
    this.instances = new Map();
  }

  /**
   * 创建编排实例。
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} [args.correlationId]
   * @param {string} args.flowName
   * @param {any[]} args.steps [{ name, provider, action, compensate, recoveryHint }]
   */
  define({ sessionId, correlationId, flowName, steps }) {
    const corr = correlationId ?? this.clock.id("corr");
    const instance = {
      correlation_id: corr,
      session_id: sessionId,
      flow_name: flowName,
      phase: "defined", // defined | running | compensating | completed | compensated
      steps: steps.map((s) => {
        const policy = policyOf(s.provider).retry;
        return {
          step_id: this.clock.id("step"),
          name: s.name,
          provider: s.provider,
          action: s.action,
          compensate: s.compensate ?? null,
          recovery_hint: s.recoveryHint ?? "请稍后重试；若仍失败可联系平台接续办理",
          retry_policy: policy,
          status: "pending",
          attempt: 0,
          max_attempts: policy.max_attempts,
          result: undefined,
          last_error: undefined,
        };
      }),
    };
    this.instances.set(corr, instance);
    return { correlationId: corr, instance: this.#external(instance) };
  }

  /**
   * 执行编排。任一步骤终态失败即转入补偿。
   * @param {string} correlationId
   * @param {object} actionCtx 传给各步 action/compensate 的业务上下文（各领域服务）
   */
  async run(correlationId, actionCtx) {
    const inst = this.instances.get(correlationId);
    if (!inst) throw new Error("编排不存在");
    inst.phase = "running";

    for (const step of inst.steps) {
      if (step.status === "succeeded") continue; // resume 时跳过已成功步骤
      const ok = await this.#runWithRetries(inst, step, actionCtx);
      if (!ok) {
        return this.beginCompensation(correlationId, actionCtx);
      }
    }
    inst.phase = "completed";
    return this.#external(inst);
  }

  /** 单步重试循环；返回是否成功。 */
  async #runWithRetries(inst, step, ctx) {
    this.#emitStep(inst, step, EventType.StepStarted, `开始处理：${step.name}（处理方：${policyOf(step.provider).label}）`);
    step.status = "running";
    step.started_at = this.clock.now();

    let lastErr;
    while (step.attempt < step.max_attempts) {
      step.attempt += 1;
      try {
        step.result = await step.action({ ...ctx, attempt: step.attempt });
        step.status = "succeeded";
        step.finished_at = this.clock.now();
        this.#emitStep(
          inst,
          step,
          EventType.StepSucceeded,
          `处理完成：${step.name}（第 ${step.attempt}/${step.max_attempts} 次尝试，处理方：${policyOf(step.provider).label}）`,
        );
        return true;
      } catch (err) {
        lastErr = err;
        step.last_error = err.message;
        const retriable = err instanceof RetryableError;
        if (retriable && step.attempt < step.max_attempts) {
          this.#emitStep(
            inst,
            step,
            EventType.StepFailed,
            `${step.name} 第 ${step.attempt}/${step.max_attempts} 次失败（${err.message}），按 ${policyOf(step.provider).label} 策略重试`,
          );
          continue;
        }
        break;
      }
    }

    step.status = "failed_retryable";
    step.finished_at = this.clock.now();
    this.#emitStep(
      inst,
      step,
      EventType.StepFailed,
      `${step.name} 已尝试 ${step.attempt}/${step.max_attempts} 次仍失败：${lastErr?.message}。继续方式：${step.recovery_hint}`,
    );
    return false;
  }

  /**
   * 启动反向补偿：只补偿此前已成功的步骤，逆序执行。
   * 补偿失败不中断整体流程状态，而是挂起为 compensating，等待 resume。
   */
  beginCompensation(correlationId, ctx) {
    return this.#compensate(correlationId, ctx, EventType.CompensationStarted, "启动跨服务补偿");
  }

  /** 从中断处继续补偿（已补偿的步骤幂等跳过）。 */
  resumeCompensation(correlationId, ctx) {
    return this.#compensate(correlationId, ctx, EventType.CompensationResumed, "恢复未完成的补偿");
  }

  async #compensate(correlationId, ctx, eventType, note) {
    const inst = this.instances.get(correlationId);
    if (!inst) throw new Error("编排不存在");
    // 已全部补偿完成：重复续跑为幂等空操作，不重复发事件、不重复回退。
    if (inst.phase === "compensated") return this.#external(inst);
    inst.phase = "compensating";
    this.store.append(
      makeEvent(this.store, this.clock, {
        type: eventType,
        aggregateType: AggregateType.OrchestrationStep,
        aggregateId: correlationId,
        correlationId,
        provider: "orchestrator",
        summary: note,
        payload: { session_id: inst.session_id },
      }),
    );

    let blockedBy = null;
    for (let i = inst.steps.length - 1; i >= 0; i -= 1) {
      const step = inst.steps[i];
      if (step.status === "compensated") continue;
      if (step.status !== "succeeded" && step.status !== "compensating") continue;

      if (!step.compensate) {
        step.status = "compensated"; // 无可补偿动作（如纯查询），直接标记
        continue;
      }
      try {
        await step.compensate({ ...ctx, result: step.result });
        step.status = "compensated";
        step.finished_at = this.clock.now();
        this.#emitStep(inst, step, EventType.StepSucceeded, `补偿完成：${step.name}（此前占用/扣款已回退，留档保留）`);
      } catch (err) {
        step.status = "compensating";
        step.last_error = err.message;
        blockedBy = step;
        this.#emitStep(
          inst,
          step,
          EventType.StepFailed,
          `补偿暂时受阻：${step.name}（${err.message}）。可在故障恢复后续跑，不会重复回退`,
        );
        break;
      }
    }

    if (!blockedBy) {
      inst.phase = "compensated";
      this.store.append(
        makeEvent(this.store, this.clock, {
          type: EventType.CompensationCompleted,
          aggregateType: AggregateType.OrchestrationStep,
          aggregateId: correlationId,
          correlationId,
          provider: "orchestrator",
          summary: "补偿全部完成：占用已释放、已扣款已原路退回，法定留档保留",
          payload: { session_id: inst.session_id },
        }),
      );
    }
    return this.#external(inst);
  }

  get(correlationId) {
    const inst = this.instances.get(correlationId);
    return inst ? this.#external(inst) : null;
  }

  #emitStep(inst, step, type, summary) {
    this.store.append(
      makeEvent(this.store, this.clock, {
        type,
        aggregateType: AggregateType.OrchestrationStep,
        aggregateId: step.step_id,
        correlationId: inst.correlation_id,
        provider: step.provider,
        summary,
        payload: {
          session_id: inst.session_id,
          step_name: step.name,
          attempt: step.attempt,
          max_attempts: step.max_attempts,
          status: step.status,
        },
      }),
    );
  }

  #external(inst) {
    return {
      correlation_id: inst.correlation_id,
      session_id: inst.session_id,
      flow_name: inst.flow_name,
      phase: inst.phase,
      steps: inst.steps.map((s) => ({
        step_id: s.step_id,
        name: s.name,
        provider: s.provider,
        status: s.status,
        attempt: s.attempt,
        max_attempts: s.max_attempts,
        last_error: s.last_error,
        recovery_hint: s.recovery_hint,
        started_at: s.started_at,
        finished_at: s.finished_at,
      })),
    };
  }
}
