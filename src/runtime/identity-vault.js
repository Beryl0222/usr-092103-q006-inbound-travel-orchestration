import { AggregateType, EventType, RetentionClass } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 身份保险库：护照原件只在核验时密封一次，之后任何环节都只能拿到：
 *  - 密封件引用 sealed_ref（出现在事件里）；
 *  - 按用途派生的最小断言（布尔资格或化名，原件字段绝不离开保险库）。
 *
 * 每次密封件访问都留审计记录（谁、为什么、何时、是否放行），
 * 运维追踪只能看到审计元数据，看不到内容。
 *
 * 数据保留：到期且无法定留档方可清除；法定留档（酒店登记/支付/退税）
 * 不受授权撤回影响，撤回只冻结后续访问。
 */
export class IdentityVault {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
    /** @type {Map<string, any>} ref -> 密封记录（内存模拟加密存储） */
    this.seals = new Map();
  }

  /**
   * 密封护照原件。
   * @param {object} raw 护照原件字段（号码/姓名/出生日期等），调用方不得另存。
   * @param {{sessionId: string, retentionClass: string, legalHold?: boolean, ttlMs?: number, source?: string}} opts
   */
  sealPassport(raw, opts) {
    const ref = this.clock.id("seal");
    const record = {
      ref,
      session_id: opts.sessionId,
      // 演示环境的“密封”：字段经一次性异或包装；真实实现替换为 KMS 加密。
      blob: this.#wrap(raw),
      retention_class: opts.retentionClass ?? RetentionClass.SessionWorking,
      legal_hold: Boolean(opts.legalHold),
      sealed_at: this.clock.now(),
      expires_at: opts.ttlMs ? new Date(new Date(this.clock.now()).getTime() + opts.ttlMs).toISOString() : undefined,
      source: opts.source ?? "border_check",
      purged: false,
      audit: [],
    };
    this.seals.set(ref, record);
    return ref;
  }

  /**
   * 按用途访问密封件。必须有对应服务的有效授权（由调用方传入校验结果），
   * 访问全程留痕。即使授权撤回，法定留档材料在法定窗口内仍可被有权机关程序性访问。
   */
  accessSealed(ref, ctx) {
    const rec = this.seals.get(ref);
    if (!rec) throw new Error("密封件不存在");
    const entry = {
      at: this.clock.now(),
      service: ctx.service,
      purpose: ctx.purpose,
      actor: ctx.actor ?? "service",
      allowed: false,
      reason: "",
    };
    if (rec.purged) {
      entry.reason = "已按保留策略清除";
    } else if (!ctx.authorized) {
      entry.reason = "无有效授权或授权已撤回";
    } else if (rec.expires_at && new Date(rec.expires_at) < new Date(this.clock.now())) {
      entry.reason = "保留期届满（需走法定留档通道）";
    } else {
      entry.allowed = true;
    }
    rec.audit.push(entry);
    if (!entry.allowed) {
      const err = new Error(`密封访问被拒绝：${entry.reason}`);
      err.code = "SEALED_ACCESS_DENIED";
      throw err;
    }
    return this.#unwrap(rec.blob);
  }

  /** 审计元数据（脱敏）：运维可见，内容不可见。 */
  auditTrail(ref) {
    const rec = this.seals.get(ref);
    if (!rec) return [];
    return rec.audit.map((a) => ({ ...a }));
  }

  setLegalHold(ref, held) {
    const rec = this.seals.get(ref);
    if (rec) rec.legal_hold = held;
  }

  /**
   * 保留清理：删除已过期且无法定留档的密封件，发出 DATA_PURGED 事件。
   * 法定留档未届满的只发 DATA_RETENTION_EXPIRED 提示，不删除。
   * @returns {{purged: string[], retained: string[]}}
   */
  sweep() {
    const purged = [];
    const retained = [];
    const now = new Date(this.clock.now());
    for (const rec of this.seals.values()) {
      if (rec.purged) continue;
      const expired = !rec.expires_at || new Date(rec.expires_at) <= now;
      if (!expired) continue;
      if (rec.legal_hold) {
        retained.push(rec.ref);
        this.#appendRetention(rec, EventType.DataRetentionExpired, true, "法定留档期内保留");
        continue;
      }
      rec.purged = true;
      rec.blob = null;
      purged.push(rec.ref);
      this.#appendRetention(rec, EventType.DataPurged, false, "保留期届满且无法定留档，已删除原件");
    }
    return { purged, retained };
  }

  #appendRetention(rec, type, legalHold, note) {
    const event = makeEvent(this.store, this.clock, {
      type,
      aggregateType: AggregateType.TravelerSession,
      aggregateId: rec.session_id,
      provider: "orchestrator",
      summary: note,
      payload: {
        session_id: rec.session_id,
        sealed_ref: rec.ref,
        retention_class: rec.retention_class,
        legal_hold: legalHold,
        retained: legalHold,
      },
    });
    this.store.append(event);
  }

  // 演示用可逆包装；表达“事件流与读模型里没有明文原件”这一架构约束。
  #wrap(raw) {
    return { alg: "demo-seal-v1", data: Buffer.from(JSON.stringify(raw), "utf8").toString("base64") };
  }
  #unwrap(blob) {
    return JSON.parse(Buffer.from(blob.data, "base64").toString("utf8"));
  }
}
