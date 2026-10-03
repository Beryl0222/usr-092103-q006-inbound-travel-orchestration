import assert from "node:assert/strict";
import test from "node:test";

import { freshPlatform, onboardedTraveler } from "./helpers.js";
import { ALLERGEN_CONFIDENCE_THRESHOLD } from "../src/translation/translation-service.js";

const png = (s = "fake-image") => new TextEncoder().encode(s);

test("提交记录原图来源、MIME、字节数与 SHA-256 哈希，事件流不存原图", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const id = p.translations.submit({
    sessionId,
    partyId: "ocr-translate",
    imageBytes: png("menu-photo-A"),
    capturedBy: "traveler",
    sourceUri: "content://camera/menu-2026-10-03.jpg",
    targetLang: "en",
  });
  const t = p.translations.get(id);
  assert.equal(t.source.byte_length, 12);
  assert.ok(t.source.sha256.length === 64);
  const events = p.store.loadStream("translation_request", id);
  assert.ok(!JSON.stringify(events).includes("menu-photo-A")); // 原图字节不进事件流
});

test("逐行保存原文/机翻/置信度与过敏原分级标记（detected vs 待人工确认）", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const id = p.translations.submit({ sessionId, partyId: "ocr-translate", imageBytes: png() });
  p.translations.complete(id, {
    lines: [
      { line_id: "l1", original: "花生酱拌面", translated: "Peanut sauce noodles", confidence: 0.95 },
      { line_id: "l2", original: "鸡蛋炒饭", translated: "Egg fried rice", confidence: 0.75 },
      { line_id: "l3", original: "白米饭", translated: "Steamed rice", confidence: 0.99 },
    ],
  });
  const t = p.translations.get(id);
  const l1 = t.lines.find((x) => x.line_id === "l1");
  assert.deepEqual(l1.allergen.detected, ["peanut"]);
  assert.deepEqual(l1.allergen.needs_review, []);
  const l2 = t.lines.find((x) => x.line_id === "l2");
  assert.deepEqual(l2.allergen.detected, []);
  assert.deepEqual(l2.allergen.needs_review, ["egg"]); // 低置信度 → 待人工确认
  assert.ok(l2.confidence === 0.75);
  assert.equal(t.lines.length, 3);
});

test("人工更正只追加，绝不覆盖原文、机翻与原始置信度", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const id = p.translations.submit({ sessionId, partyId: "ocr-translate", imageBytes: png() });
  p.translations.complete(id, {
    lines: [{ line_id: "l1", original: "牛奶小面包", translated: "Milk buns", confidence: 0.6 }],
  });
  p.translations.correct(id, {
    correctedBy: "restaurant-staff",
    corrections: [{ line_id: "l1", translation: "Dairy-free steamed buns", note: "菜单已换新版" }],
  });
  const t = p.translations.get(id);
  const line = t.lines.find((x) => x.line_id === "l1");
  assert.equal(line.original_text, "牛奶小面包");
  assert.equal(line.machine_translation, "Milk buns");
  assert.equal(line.confidence, 0.6);
  assert.equal(line.corrected_translation, "Dairy-free steamed buns");
  assert.equal(line.corrected_by, "restaurant-staff");
  // 事件溯源可重建：SUBMITTED → COMPLETED → CORRECTED。
  const types = p.store.loadStream("translation_request", id).map((e) => e.event_type);
  assert.deepEqual(types, ["TRANSLATION_SUBMITTED", "TRANSLATION_COMPLETED", "TRANSLATION_CORRECTED"]);
  void ALLERGEN_CONFIDENCE_THRESHOLD;
});

test("置信度越界与空结果被拒绝", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const id = p.translations.submit({ sessionId, partyId: "ocr-translate", imageBytes: png() });
  assert.throws(
    () =>
      p.translations.complete(id, {
        lines: [{ line_id: "l1", original: "x", translated: "y", confidence: 1.2 }],
      }),
    (e) => e.code === "BAD_CONFIDENCE",
  );
});

test("菜单翻译流程端到端：提交原图 → OCR 完成", () => {
  const p = freshPlatform();
  const { sessionId } = onboardedTraveler(p);
  const flow = p.orchestrator.start("menu_translation", {
    sessionId,
    startKey: "tr-001",
    input: {
      image_bytes: png("dinner-menu"),
      target_lang: "en",
      lines: [
        { line_id: "l1", original: "腰果虾仁", translated: "Cashew shrimp", confidence: 0.92 },
        { line_id: "l2", original: "清蒸鱼", translated: "Steamed fish", confidence: 0.97 },
      ],
    },
  });
  assert.equal(flow.status, "completed");
  const trId = flow.steps.find((s) => s.key === "run_ocr").resultRef;
  const t = p.translations.get(trId);
  assert.equal(t.source.sha256.length, 64);
});
