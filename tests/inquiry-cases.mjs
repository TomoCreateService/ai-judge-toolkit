import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConditions } from "../src/conditions.mjs";
import { REVIEW_FLAG } from "../src/engine.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const validateAnswerKey = (records, answers, categories) => {
  if (!Array.isArray(records) || records.length === 0 || !Array.isArray(answers)) {
    throw new Error("入力と正解表は配列にし、入力を1件以上用意してください");
  }
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || !record.id.trim() || typeof record.subject !== "string" || typeof record.body !== "string") {
      throw new Error("入力にはID・件名・本文が必要です");
    }
    if (ids.has(record.id)) throw new Error(`入力のIDが重複しています: ${record.id}`);
    ids.add(record.id);
  }
  const answerIds = new Set();
  for (const answer of answers) {
    if (!answer || !ids.has(answer.id)) throw new Error(`正解表に入力にないIDがあります: ${answer?.id ?? "未指定"}`);
    if (answerIds.has(answer.id)) throw new Error(`正解表のIDが重複しています: ${answer.id}`);
    if (!categories.includes(answer.category)) throw new Error(`正解表の分類が選択肢にありません: ${answer.id}`);
    if (typeof answer.needsReview !== "boolean") throw new Error(`正解表の要確認はtrueかfalseにしてください: ${answer.id}`);
    answerIds.add(answer.id);
  }
  const missing = [...ids].filter((id) => !answerIds.has(id));
  if (missing.length) throw new Error(`正解表に不足しているIDがあります: ${missing.join("、")}`);
};

export const loadInquiryCases = () => {
  const records = JSON.parse(readFileSync(resolve(ROOT, "examples/inquiry/inputs.json"), "utf-8"));
  const answers = JSON.parse(readFileSync(resolve(ROOT, "examples/inquiry/answer-key.json"), "utf-8"));
  const conditions = loadConditions(resolve(ROOT, "examples/inquiry/conditions.md"));
  const categories = conditions.columns.find((column) => column.key === "category").values;
  validateAnswerKey(records, answers, categories);
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  return { records, answers, conditions, cases: records.map((record) => ({ record, answer: byId.get(record.id) })) };
};

export const compareResult = (result, answer) => {
  const differences = [];
  if (result.error) differences.push(`判定エラー: ${result.error}`);
  if (result.rows.length !== 1) {
    differences.push(`判定結果は1行必要ですが、${result.rows.length}行でした`);
    return { passed: false, differences, actual: null };
  }
  const row = result.rows[0];
  const actual = { category: row.category ?? null, needsReview: row.needsReview === REVIEW_FLAG, confidence: row.confidence ?? null };
  if (actual.category !== answer.category) {
    differences.push(`分類: 正解「${answer.category}」、実際「${actual.category ?? "取得できません"}」`);
  }
  if (row.needsReview !== "" && row.needsReview !== REVIEW_FLAG) differences.push("要確認の値が不正です");
  if (actual.needsReview !== answer.needsReview) {
    differences.push(`要確認: 正解「${answer.needsReview ? "あり" : "なし"}」、実際「${actual.needsReview ? "あり" : "なし"}」`);
  }
  return { passed: differences.length === 0, differences, actual };
};
