import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAiClient, DEFAULT_MODEL } from "../src/ai-client.mjs";
import { runJudge } from "../src/engine.mjs";
import { compareResult, loadInquiryCases, ROOT } from "./inquiry-cases.mjs";

const main = async () => {
  console.log("実APIテストにはANTHROPIC_API_KEYが必要です。APIを呼び出すため利用料金が発生します。");
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("APIキーがありません。.env.exampleを.envにコピーし、ANTHROPIC_API_KEYを設定してください。テストは未実行です");

  const { cases, conditions } = loadInquiryCases();
  const model = process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
  const reportPath = resolve(ROOT, "output/inquiry-test-report.json");
  const responsesPath = resolve(ROOT, "output/inquiry-test-responses.json");
  mkdirSync(resolve(ROOT, "output"), { recursive: true });
  writeFileSync(responsesPath, "{}\n");
  const client = createAiClient({ model, responsesPath });
  const byId = new Map(cases.map((item) => [item.record.id, item.answer]));
  const outcomes = [];
  const startedAt = performance.now();
  console.log(`モデル: ${model} / 正解表と比較する入力: ${cases.length}件`);

  try {
    await runJudge({
      items: cases.map(({ record }) => ({ id: record.id, label: `${record.id} ${record.subject}`, payload: record, passthrough: { subject: record.subject, receivedAt: record.receivedAt } })),
      conditions,
      client,
      onResult: (result) => {
        const expected = byId.get(result.item.id);
        const comparison = compareResult(result, expected);
        outcomes.push({ id: result.item.id, subject: result.item.payload.subject, expected, ...comparison, warnings: result.warnings, error: result.error });
        console.log(`${comparison.passed ? "合格" : "不合格"}: ${result.item.label}`);
        for (const message of comparison.differences) console.log(`  ${message}`);
      },
    });
  } catch (error) {
    for (const { record, answer } of cases.slice(outcomes.length)) {
      outcomes.push({ id: record.id, subject: record.subject, expected: answer, actual: null, passed: false, differences: [`未実行: ${error.message}`], warnings: [], error: error.message });
      console.log(`不合格: ${record.id} ${record.subject}\n  未実行: ${error.message}`);
    }
  }

  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const failed = outcomes.length - passed;
  const durationSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
  mkdirSync(resolve(ROOT, "output"), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ executedAt: new Date().toISOString(), model, passed, failed, durationSeconds, usage: client.usage, outcomes }, null, 2)}\n`);
  console.log(`\n合格${passed}件・不合格${failed}件`);
  console.log(`処理時間: ${durationSeconds}秒 / API: ${client.usage.requests}リクエスト`);
  if (client.usage.costUsd !== null) console.log(`推定費用: 約$${client.usage.costUsd.toFixed(4)}（約${(client.usage.costUsd * 150).toFixed(2)}円・1ドル150円換算）`);
  console.log(`比較結果: ${reportPath}\nAPIの回答: ${responsesPath}`);
  if (failed) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`エラー: ${error.message}`);
  process.exitCode = 1;
});
