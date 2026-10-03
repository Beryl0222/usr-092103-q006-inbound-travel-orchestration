import { createHash } from "node:crypto";
import { AggregateType, EventType } from "../contracts.js";
import { makeEvent } from "./envelope.js";

/**
 * 已知过敏原词表（演示：中英）。英文按词边界匹配（避免 peanut 误报 nut），
 * 中文按子串匹配；识别命中会在结果中显著标注。
 * 每组首项为规范名，其余为中英文触发词。
 */
const ALLERGEN_TERMS = [
  { canonical: "花生", zh: ["花生"], en: ["peanut", "peanuts"] },
  { canonical: "坚果", zh: ["坚果"], en: ["nut", "nuts", "tree nut", "tree nuts", "almond", "walnut", "cashew"] },
  { canonical: "虾", zh: ["虾"], en: ["shrimp", "prawn", "prawns"] },
  { canonical: "蟹", zh: ["蟹"], en: ["crab"] },
  { canonical: "牛奶", zh: ["牛奶", "奶制品"], en: ["milk", "dairy", "cheese", "butter"] },
  { canonical: "鸡蛋", zh: ["鸡蛋", "蛋"], en: ["egg", "eggs"] },
  { canonical: "小麦", zh: ["小麦"], en: ["wheat", "gluten", "flour"] },
  { canonical: "大豆", zh: ["大豆", "黄豆"], en: ["soy", "soya", "soybean"] },
];

/**
 * 拍照翻译服务。
 *
 * 溯源要求：每条翻译必须保留
 *  - 原图来源（拍摄时间、上传渠道、图片内容哈希；平台不留可还原影像的工作副本）；
 *  - OCR 识别文本与置信度；
 *  - 过敏原命中提示；
 *  - 人工更正历史（谁、何时、从什么改成什么），更正不覆盖机器结果，而是追加。
 *
 * 游客看到的是“机器识别 + 置信度 + 更正记录”的完整链条，
 * 过敏原场景下低置信度结果必须显式提示风险，不得静默给出确定结论。
 */
export class TranslationService {
  constructor(store, clock, ocrEngine = defaultOcrEngine) {
    this.store = store;
    this.clock = clock;
    this.ocrEngine = ocrEngine;
    /** @type {Map<string, any>} */
    this.requests = new Map();
  }

  /**
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} args.correlationId
   * @param {Buffer|string} args.image 原图（演示中只保存哈希）
   * @param {{channel?: string, capturedAt?: string}} [args.source]
   */
  request({ sessionId, correlationId, image, source = {} }) {
    const imageBuffer = Buffer.isBuffer(image) ? image : Buffer.from(String(image), "utf8");
    const imageHash = createHash("sha256").update(imageBuffer).digest("hex");
    const detected = this.ocrEngine(imageBuffer);
    const allergenFlags = detectAllergens(detected.text);

    const id = this.clock.id("trl");
    const state = {
      translation_id: id,
      session_id: sessionId,
      source: {
        captured_at: source.capturedAt ?? this.clock.now(),
        channel: source.channel ?? "visitor-app",
        image_hash: imageHash,
      },
      detected_text: detected.text,
      confidence: detected.confidence,
      translated_text: detected.translation,
      allergen_flags: allergenFlags,
      low_confidence_warning: detected.confidence < 0.85,
      corrections: [],
    };
    this.requests.set(id, state);

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.TranslationRequested,
        aggregateType: AggregateType.TranslationRequest,
        aggregateId: id,
        correlationId,
        provider: "translation",
        summary:
          `拍照翻译完成（置信度 ${(detected.confidence * 100).toFixed(0)}%` +
          `${allergenFlags.length ? `，过敏原提示：${allergenFlags.join("、")}` : ""}` +
          `${state.low_confidence_warning ? "，低置信度需人工核对" : ""}）`,
        payload: {
          session_id: sessionId,
          image_hash: imageHash,
          confidence: detected.confidence,
          allergen_flags: allergenFlags,
          low_confidence_warning: state.low_confidence_warning,
        },
      }),
    );
    return this.#external(state);
  }

  /**
   * 人工更正（游客本人或平台坐席）。更正追加留痕，不改写机器识别原文与置信度。
   */
  correct({ translationId, correctedBy, toText }) {
    const t = this.requests.get(translationId);
    if (!t) throw new Error("翻译请求不存在");
    const fromText = t.translated_text;
    const entry = {
      corrected_by: correctedBy,
      at: this.clock.now(),
      from_text: fromText,
      to_text: toText,
    };
    t.corrections.push(entry);
    t.translated_text = toText;

    this.store.append(
      makeEvent(this.store, this.clock, {
        type: EventType.TranslationCorrected,
        aggregateType: AggregateType.TranslationRequest,
        aggregateId: translationId,
        provider: "translation",
        summary: `翻译经 ${correctedBy} 人工更正（机器原文保留，置信度 ${(t.confidence * 100).toFixed(0)}%）`,
        payload: {
          session_id: t.session_id,
          image_hash: t.source.image_hash,
          confidence: t.confidence,
          allergen_flags: t.allergen_flags,
        },
      }),
    );
    return this.#external(t);
  }

  get(translationId) {
    const t = this.requests.get(translationId);
    return t ? this.#external(t) : null;
  }

  listBySession(sessionId) {
    return [...this.requests.values()].filter((t) => t.session_id === sessionId).map((t) => this.#external(t));
  }

  #external(t) {
    return { ...t, source: { ...t.source }, corrections: t.corrections.map((c) => ({ ...c })) };
  }
}

function detectAllergens(text) {
  const lower = text.toLowerCase();
  const hits = new Set();
  for (const group of ALLERGEN_TERMS) {
    if (group.zh.some((term) => text.includes(term))) hits.add(group.canonical);
    if (group.en.some((term) => new RegExp(`(^|[^a-z])${escapeRegExp(term)}([^a-z]|$)`).test(lower))) {
      hits.add(group.canonical);
    }
  }
  return [...hits];
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 默认演示 OCR：图片载荷为 JSON 文本时直接采用；否则给出占位识别。
 * 真实实现替换为 OCR 服务适配，返回结构保持 { text, translation, confidence }。
 */
function defaultOcrEngine(imageBuffer) {
  const maybeJson = safeJson(imageBuffer.toString("utf8"));
  if (maybeJson && typeof maybeJson.text === "string") {
    return {
      text: maybeJson.text,
      translation: maybeJson.translation ?? `【机器翻译】${maybeJson.text}`,
      confidence: typeof maybeJson.confidence === "number" ? maybeJson.confidence : 0.9,
    };
  }
  return { text: imageBuffer.toString("utf8").slice(0, 200), translation: "【无法识别】", confidence: 0.3 };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
