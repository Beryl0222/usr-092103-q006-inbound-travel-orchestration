import { createHash } from "node:crypto";
import { AggregateType, EventType } from "../domain.ts";
import { fail } from "../platform/errors.js";
import { newId } from "../platform/ids.js";

/** 置信度阈值：过敏原识别低于该值必须标“待人工确认”，不得直接断言无过敏原。 */
export const ALLERGEN_CONFIDENCE_THRESHOLD = 0.9;

/** 常见过敏原词表（演示中中英对照；生产应由识别引擎提供多语词库）。 */
const ALLERGEN_TERMS = [
  { canonical: "peanut", patterns: ["花生", "peanut", "ピーナッツ", "땅콩"] },
  { canonical: "shellfish", patterns: ["虾", "贝", "蟹", "shellfish", "shrimp", "甲殻類"] },
  { canonical: "egg", patterns: ["蛋", "egg", "卵", "계란"] },
  { canonical: "milk", patterns: ["奶", "牛奶", "milk", "乳", "유제품"] },
  { canonical: "tree_nut", patterns: ["坚果", "杏仁", "nut", "almond", "ナッツ"] },
  { canonical: "gluten", patterns: ["小麦", "面粉", "gluten", "wheat", "小麦粉"] },
];

/**
 * 拍照翻译域（菜单与过敏原场景）。
 *
 * 不可变溯源链：
 * 1. SUBMITTED 记录原图来源（拍摄设备/商户）、字节哈希、MIME、拍摄时间——
 *    原图内容本身不进事件流，事件只持有可核验的 source 与 hash；
 * 2. COMPLETED 逐行保存 OCR 原文、译文、引擎版本、置信度，
 *    并对命中的过敏原给出 detected / needs_review 两级标记；
 * 3. CORRECTED 只追加人工更正，绝不覆盖 OCR 原文与置信度，
 *    游客/服务方看到的是“原文 + 机翻 + 人工更正”三层并存的结果。
 */
export class TranslationService {
  #store;
  #clock;
  #registry;
  #requests = new Map();

  constructor({ store, clock, registry }) {
    this.#store = store;
    this.#clock = clock;
    this.#registry = registry;
    store.subscribe((e) => this.#apply(e));
  }

  #apply(event) {
    if (event.aggregate_type !== AggregateType.TranslationRequest) return;
    const p = event.payload;
    const t = this.#requests.get(event.aggregate_id) ?? { id: event.aggregate_id, lines: [], corrections: [] };
    if (event.event_type === EventType.TranslationSubmitted) {
      t.sessionId = p.session_id;
      t.partyId = p.party_id;
      t.source = p.source;
      t.targetLang = p.target_lang;
      t.submittedAt = event.occurred_at;
      t.status = "submitted";
    }
    if (event.event_type === EventType.TranslationCompleted) {
      t.status = "completed";
      t.engine = p.engine;
      t.lines = structuredClone(p.lines);
      t.completedAt = event.occurred_at;
    }
    if (event.event_type === EventType.TranslationCorrected) {
      for (const c of p.corrections) {
        const line = t.lines.find((l) => l.line_id === c.line_id);
        if (line) {
          line.corrected_translation = c.translation;
          line.correction_note = c.note ?? null;
          line.corrected_by = p.corrected_by;
        }
        t.corrections.push({ ...c, corrected_by: p.corrected_by, at: event.occurred_at });
      }
    }
    this.#requests.set(event.aggregate_id, t);
  }

  /**
   * 提交拍照翻译。
   * imageBytes 仅用于计算内容哈希留证，不落库、不外传。
   */
  submit({ sessionId, partyId, imageBytes, mimeType = "image/jpeg", capturedBy, sourceUri, targetLang = "en", context = "menu" }) {
    this.#registry.get(partyId);
    if (!imageBytes || !(imageBytes instanceof Uint8Array))
      fail("IMAGE_REQUIRED", "提交翻译必须提供原图字节（用于来源哈希）");
    const id = newId("tr");
    const hash = createHash("sha256").update(imageBytes).digest("hex");
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.TranslationSubmitted,
        aggregate_type: AggregateType.TranslationRequest,
        aggregate_id: id,
        occurred_at: this.#clock.now(),
        version: 1,
        summary: `提交${context === "menu" ? "菜单" : context}拍照翻译，目标语言 ${targetLang}`,
        correlation_id: sessionId,
        payload: {
          session_id: sessionId,
          party_id: partyId,
          target_lang: targetLang,
          context,
          source: {
            uri: sourceUri ?? null,
            captured_by: capturedBy ?? "traveler",
            mime_type: mimeType,
            byte_length: imageBytes.length,
            sha256: hash,
            captured_at: this.#clock.now(),
          },
        },
      },
      0,
    );
    return id;
  }

  /**
   * 识别引擎回传结果（演示用：由调用方提供逐行 OCR；真实系统由引擎适配器产出）。
   * 每行：{ line_id, original, source_lang, translated, confidence, bbox? }。
   * 过敏原标记在此处统一计算，保证规则一致、可审计。
   */
  complete(requestId, { lines, engine = { name: "demo-ocr", version: "1.0" } }) {
    const t = this.get(requestId);
    if (t.status === "completed") fail("TRANSLATION_ALREADY_COMPLETED", "识别结果只能回传一次；更正请使用 correct");
    if (!Array.isArray(lines) || lines.length === 0) fail("NO_LINES", "识别结果至少包含一行");
    const enriched = lines.map((line) => {
      for (const k of ["line_id", "original", "translated", "confidence"]) {
        if (line[k] === undefined) fail("LINE_INCOMPLETE", `识别行缺少字段：${k}`);
      }
      const conf = Number(line.confidence);
      if (!(conf >= 0 && conf <= 1)) fail("BAD_CONFIDENCE", "置信度必须在 0..1");
      const hits = detectAllergens(`${line.original ?? ""} ${line.translated ?? ""}`);
      return {
        line_id: line.line_id,
        bbox: line.bbox ?? null,
        source_lang: line.source_lang ?? null,
        original_text: line.original, // 不可变原文
        machine_translation: line.translated, // 不可变机翻
        confidence: Number(conf.toFixed(4)),
        allergen: hits.length
          ? {
              detected: hits.filter((h) => conf >= ALLERGEN_CONFIDENCE_THRESHOLD).map((h) => h.canonical),
              needs_review: hits.filter((h) => conf < ALLERGEN_CONFIDENCE_THRESHOLD).map((h) => h.canonical),
            }
          : { detected: [], needs_review: [] },
      };
    });
    const version = this.#store.versionOf(AggregateType.TranslationRequest, requestId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.TranslationCompleted,
        aggregate_type: AggregateType.TranslationRequest,
        aggregate_id: requestId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `识别完成 ${enriched.length} 行，过敏原命中 ${enriched.reduce((n, l) => n + l.allergen.detected.length + l.allergen.needs_review.length, 0)} 处`,
        correlation_id: t.sessionId,
        payload: { lines: enriched, engine },
      },
      version,
    );
    return this.get(requestId);
  }

  /**
   * 人工更正：只追加 CORRECTED 事件。
   * OCR 原文、机翻与原始置信度保持不变，更正与原文并列展示，供过敏安全追责。
   */
  correct(requestId, { corrections, correctedBy }) {
    const t = this.get(requestId);
    if (t.status !== "completed") fail("TRANSLATION_NOT_COMPLETED", "只能更正已完成的翻译");
    if (!Array.isArray(corrections) || corrections.length === 0) fail("NO_CORRECTIONS", "至少提供一条更正");
    const lineIds = new Set(t.lines.map((l) => l.line_id));
    for (const c of corrections) {
      if (!lineIds.has(c.line_id)) fail("UNKNOWN_LINE", `更正目标行不存在：${c.line_id}`);
      if (typeof c.translation !== "string" || !c.translation) fail("CORRECTION_EMPTY", "更正译文不能为空");
    }
    const version = this.#store.versionOf(AggregateType.TranslationRequest, requestId);
    this.#store.append(
      {
        event_id: newId("evt"),
        event_type: EventType.TranslationCorrected,
        aggregate_type: AggregateType.TranslationRequest,
        aggregate_id: requestId,
        occurred_at: this.#clock.now(),
        version: version + 1,
        summary: `${correctedBy} 人工更正 ${corrections.length} 行（原文保留）`,
        correlation_id: t.sessionId,
        payload: { corrected_by: correctedBy, corrections },
      },
      version,
    );
    return this.get(requestId);
  }

  get(requestId) {
    const t = this.#requests.get(requestId);
    if (!t) fail("TRANSLATION_NOT_FOUND", `翻译请求不存在：${requestId}`);
    return structuredClone(t);
  }
}

export function detectAllergens(text) {
  const lower = String(text).toLowerCase();
  return ALLERGEN_TERMS.filter((term) =>
    term.patterns.some((p) => {
      const needle = p.toLowerCase();
      // 拉丁字母词用词边界，避免 “peanut” 误命中 tree_nut 的 “nut”；中日文用词串包含。
      if (/^[a-z]+$/.test(needle)) return new RegExp(`\\b${needle}\\b`).test(lower);
      return lower.includes(needle);
    }),
  );
}
