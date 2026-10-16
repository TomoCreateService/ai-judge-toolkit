import test from "node:test";
import assert from "node:assert/strict";
import { buildSchema, buildSystemPrompt, runJudge } from "../src/engine.mjs";
import { FatalError } from "../src/ai-client.mjs";
import { compareResult, loadInquiryCases, validateAnswerKey } from "./inquiry-cases.mjs";

const { records, answers, conditions } = loadInquiryCases();
const categories = conditions.columns.find((column) => column.key === "category").values;
const response = (changes = {}) => ({ category: categories[0], priority: "中", summary: "サイト制作の費用と進め方を相談", reason: "本文に制作依頼が明記されているため", confidence: "高", ...changes });
const judge = async (data, settings = conditions) => {
  const results = await runJudge({
    items: [{ id: "test-001", label: "テスト用の問い合わせ", payload: { body: "制作を相談したい" }, passthrough: { subject: "ご依頼" } }],
    conditions: settings,
    client: { judge: async () => data },
  });
  return results[0];
};

test("高確信度で上限内なら要確認を付けず、入力の件名を維持する", async () => {
  const result = await judge(response());
  assert.equal(result.error, null);
  assert.equal(result.rows[0].needsReview, "");
  assert.equal(result.rows[0].subject, "ご依頼");
});

test("中確信度だけでは要確認を付けない", async () => {
  assert.equal((await judge(response({ confidence: "中" }))).rows[0].needsReview, "");
});

test("低確信度なら要確認を付ける", async () => {
  assert.equal((await judge(response({ confidence: "低" }))).rows[0].needsReview, "要確認");
});

test("要約が上限50文字ちょうどなら切り詰めず要確認を付けない", async () => {
  const summary = "あ".repeat(50);
  const result = await judge(response({ summary }));
  assert.equal(result.rows[0].summary, summary);
  assert.equal(result.rows[0].needsReview, "");
  assert.deepEqual(result.warnings, []);
});

test("要約が51文字なら50文字に切り詰め、要確認と警告を付ける", async () => {
  const result = await judge(response({ summary: "あ".repeat(51) }));
  assert.equal(result.rows[0].summary, "あ".repeat(50));
  assert.equal(result.rows[0].needsReview, "要確認");
  assert.deepEqual(result.warnings, ["要約が50文字を超えたため切り詰めました"]);
});

test("絵文字も1文字として数え、切り詰めで文字を壊さない", async () => {
  const within = await judge(response({ summary: "😀".repeat(50) }));
  const over = await judge(response({ summary: "😀".repeat(51) }));
  assert.equal(within.rows[0].needsReview, "");
  assert.equal(over.rows[0].summary, "😀".repeat(50));
  assert.equal(over.rows[0].needsReview, "要確認");
});

test("判定理由が100文字を超えた場合も要確認を付ける", async () => {
  const result = await judge(response({ reason: "あ".repeat(101) }));
  assert.equal([...result.rows[0].reason].length, 100);
  assert.equal(result.rows[0].needsReview, "要確認");
  assert.deepEqual(result.warnings, ["判定理由が100文字を超えたため切り詰めました"]);
});

test("分類が選択肢外なら判定エラーとして要確認にする", async () => {
  const result = await judge(response({ category: "未定義の分類" }));
  assert.match(result.error, /分類.*選択肢にありません/);
  assert.equal(result.rows[0].needsReview, "要確認");
});

test("確信度が選択肢外なら判定エラーにする", async () => {
  assert.match((await judge(response({ confidence: "最高" }))).error, /確信度.*選択肢にありません/);
});

test("必須項目が欠けていれば判定エラーにする", async () => {
  const data = response();
  delete data.summary;
  assert.match((await judge(data)).error, /summary.*ありません/);
});

test("文字列項目が数値なら判定エラーにする", async () => {
  assert.match((await judge(response({ summary: 123 }))).error, /summary.*ありません/);
});

test("JSONの内容がオブジェクトでなければ判定エラーにする", async () => {
  assert.match((await judge(null)).error, /オブジェクトではありません/);
});

test("1件の応答失敗があっても次の入力を判定する", async () => {
  const results = await runJudge({
    items: ["bad", "good"].map((id) => ({ id, label: id, payload: {}, passthrough: {} })),
    conditions,
    client: { judge: async ({ id }) => { if (id === "bad") throw new Error("テスト用の応答失敗"); return response(); } },
  });
  assert.equal(results.length, 2);
  assert.match(results[0].error, /テスト用の応答失敗/);
  assert.equal(results[1].error, null);
});

test("認証エラーなど続行できない失敗は処理を中断する", async () => {
  await assert.rejects(runJudge({
    items: [{ id: "fatal", label: "認証失敗", payload: {}, passthrough: {} }],
    conditions,
    client: { judge: async () => { throw new FatalError("APIキーが無効です"); } },
  }), /認証失敗.*APIキーが無効/);
});

test("複数行の判定でも低確信度に要確認を付ける", async () => {
  const rowsConditions = { ...conditions, output: "rows", columns: conditions.columns.filter((column) => column.source === "ai") };
  const result = await judge({ findings: [response(), response({ confidence: "低" })] }, rowsConditions);
  assert.equal(result.error, null);
  assert.deepEqual(result.rows.map((row) => row.needsReview), ["", "要確認"]);
});

test("要約は30文字以内と指示し、安全策の上限50文字を維持する", () => {
  const summary = conditions.columns.find((column) => column.key === "summary");
  assert.equal(summary.targetLength, 30);
  assert.equal(summary.maxLength, 50);
  assert.match(buildSystemPrompt(conditions), /summary（要約）.*30文字以内/);
  assert.match(buildSchema(conditions).properties.summary.description, /30文字以内/);
});

test("正解表と入力のIDが一致し、確定した01・26・27・30を維持する", () => {
  validateAnswerKey(records, answers, categories);
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  assert.deepEqual(byId.get("inq-001"), { id: "inq-001", category: categories[0], needsReview: false });
  assert.equal(byId.get("inq-026").needsReview, true);
  assert.equal(byId.get("inq-027").category, "その他");
  assert.equal(byId.get("inq-030").category, "その他");
});

test("正解表の不足・余分なID・重複・不正な分類・要確認の型を検出する", () => {
  assert.throws(() => validateAnswerKey(records, answers.slice(1), categories), /不足/);
  assert.throws(() => validateAnswerKey(records, [...answers, { ...answers[0], id: "unknown" }], categories), /入力にないID/);
  assert.throws(() => validateAnswerKey(records, [...answers, answers[0]], categories), /重複/);
  assert.throws(() => validateAnswerKey(records, answers.map((answer, i) => i ? answer : { ...answer, category: "不正" }), categories), /選択肢/);
  assert.throws(() => validateAnswerKey(records, answers.map((answer, i) => i ? answer : { ...answer, needsReview: "false" }), categories), /trueかfalse/);
  assert.throws(() => validateAnswerKey([...records, records[0]], answers, categories), /入力のIDが重複/);
});

test("分類と要確認の両方が正解に一致した場合だけ合格にする", () => {
  const answer = { category: categories[0], needsReview: false };
  const result = { error: null, rows: [{ category: categories[0], needsReview: "", confidence: "高" }] };
  assert.equal(compareResult(result, answer).passed, true);
  assert.equal(compareResult({ ...result, rows: [{ ...result.rows[0], category: "その他" }] }, answer).passed, false);
  assert.equal(compareResult({ ...result, rows: [{ ...result.rows[0], needsReview: "要確認" }] }, answer).passed, false);
  assert.equal(compareResult({ ...result, error: "失敗" }, answer).passed, false);
  assert.equal(compareResult({ error: null, rows: [] }, answer).passed, false);
});
