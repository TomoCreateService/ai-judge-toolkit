import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, FatalError, createAiClient } from "./ai-client.mjs";
import { createSampleClient } from "./sample-client.mjs";
import { runRecords } from "./runners/records.mjs";
import { runSiteCheck } from "./runners/site-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `使い方:
  node src/cli.mjs --example inquiry [--sample] [--limit 3]
  node src/cli.mjs --example site-check --serve-fixtures [--sample]
  node src/cli.mjs --conditions <条件ファイル> --input <入力JSON> [--output <CSVパス>]

オプション:
  --example <名前>     examples/ 配下のデモ（inquiry / site-check）
  --sample             AIのAPIを呼ばず、サンプル回答で実行する
  --limit <件数>       先頭から指定件数だけ判定する
  --conditions <パス>  条件ファイル（.json / .md）を差し替える
  --input <パス>       入力ファイルを差し替える
  --output <パス>      出力CSVのパスを変える
  --save-responses <パス>  実APIの回答をサンプル用JSONに保存する
  --serve-fixtures     tests/fixtures/site をローカル配信してからチェックする（site-check用）`;

const EXAMPLES = {
  inquiry: {
    run: runRecords,
    conditions: "examples/inquiry/conditions.md",
    input: "examples/inquiry/inputs.json",
    output: "output/inquiry_result.csv",
    responses: "examples/inquiry/sample-responses.json",
    summary: "output/inquiry_summary.md",
  },
  "site-check": {
    run: runSiteCheck,
    conditions: "examples/site-check/conditions.json",
    input: "examples/site-check/urls.txt",
    output: "output/site_check_report.csv",
    summary: "output/site_check_summary.md",
    responses: "examples/site-check/sample-responses.json",
  },
};

const exitWithUsage = (message) => {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
};

const parseOptions = () => {
  try {
    return parseArgs({
      options: {
        example: { type: "string" },
        sample: { type: "boolean", default: false },
        limit: { type: "string" },
        conditions: { type: "string" },
        input: { type: "string" },
        output: { type: "string" },
        "serve-fixtures": { type: "boolean", default: false },
        "save-responses": { type: "string" },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    return exitWithUsage(error.message);
  }
};

const buildSettings = (args) => {
  const example = args.example ? EXAMPLES[args.example] : null;
  if (args.example && !example)
    exitWithUsage(
      `--example は ${Object.keys(EXAMPLES).join(" / ")} のどれかを指定してください`,
    );
  if (!example && !(args.conditions && args.input))
    exitWithUsage(
      "--example を指定するか、--conditions と --input の両方を指定してください",
    );
  if (!example && args.sample)
    exitWithUsage(
      "--sample は --example と一緒に使ってください（サンプル回答はデモ用のものしかありません）",
    );

  const limit = args.limit === undefined ? Infinity : Number(args.limit);
  if (!(limit === Infinity || (Number.isInteger(limit) && limit > 0)))
    exitWithUsage("--limit は1以上の整数を指定してください");

  const fromRoot = (path) => (path ? resolve(ROOT, path) : undefined);
  return {
    root: ROOT,
    run: example?.run ?? runRecords,
    conditionsPath: resolve(args.conditions ?? join(ROOT, example.conditions)),
    inputPath: resolve(args.input ?? join(ROOT, example.input)),
    outputPath: resolve(
      args.output ?? join(ROOT, example?.output ?? "output/result.csv"),
    ),
    summaryPath: fromRoot(example?.summary),
    responsesPath: fromRoot(example?.responses),
    limit,
    serveFixtures: args["serve-fixtures"],
  };
};

const formatYen = (yen) =>
  yen < 1 ? `約${yen.toFixed(2)}円` : `約${Math.round(yen)}円`;

const formatUsd = (usd) =>
  `約$${usd.toFixed(4)}（${formatYen(usd * 150)}・1ドル150円換算）`;

const main = async () => {
  const envPath = join(ROOT, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const args = parseOptions();
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.sample && args["save-responses"])
    exitWithUsage("--save-responses は実APIでの実行時のみ使えます");
  const startedAt = performance.now();
  const elapsedSeconds = () =>
    Math.round((performance.now() - startedAt) / 100) / 10;
  const settings = buildSettings(args);
  const model = process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
  const createClient = () =>
    args.sample
      ? createSampleClient({ responsesPath: settings.responsesPath })
      : createAiClient({
          model,
          responsesPath: args["save-responses"]
            ? resolve(args["save-responses"])
            : undefined,
        });

  console.log(
    args.sample
      ? "モード: サンプル実行（AIのAPIは呼びません）"
      : `モード: AI判定（モデル: ${model}）`,
  );
  const { usage, failures, outputs, durationSeconds } = await settings.run({
    ...settings,
    createClient,
    elapsedSeconds,
  });

  console.log("\n--- 完了 ---");
  for (const path of outputs) console.log(`出力: ${path}`);
  if (!args.sample) {
    const cost = usage.costUsd;
    console.log(
      `API: ${usage.requests}リクエスト / 入力 ${usage.inputTokens} / 出力 ${usage.outputTokens}トークン`,
    );
    console.log(
      cost === null
        ? "推定費用: このモデルの料金表がないため計算していません"
        : `推定費用: ${formatUsd(cost)}`,
    );
  }
  if (failures.length > 0) {
    console.error(
      `\n失敗 ${failures.length}件（CSVには「判定失敗」として記録済み）:`,
    );
    for (const message of failures) console.error(`  - ${message}`);
    process.exitCode = 1;
  }
  console.log(`処理時間：${durationSeconds}秒`);
};

main().catch((error) => {
  console.error(
    error instanceof FatalError ? `\nエラー: ${error.message}` : error,
  );
  process.exit(1);
});
