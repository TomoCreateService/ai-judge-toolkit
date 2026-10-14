import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConditions } from "../conditions.mjs";
import { writeCsv } from "../csv.mjs";
import { outputColumns, runJudge } from "../engine.mjs";
import { buildRecordsSummaryMarkdown } from "../site/report.mjs";
import { FatalError } from "../ai-client.mjs";

const loadRecords = (path) => {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new FatalError(
      `入力ファイル ${path} を読み込めません（${error.code === "ENOENT" ? "ファイルが見つかりません" : error.message}）`,
    );
  }
  if (!Array.isArray(data))
    throw new FatalError(
      `入力ファイル ${path} は配列（[ ... ]）のJSONにしてください`,
    );
  return data.map((record, i) => {
    if (typeof record !== "object" || record === null)
      throw new FatalError(
        `入力ファイル ${path} の${i + 1}件目がオブジェクトではありません`,
      );
    return { id: String(record.id ?? `#${i + 1}`), ...record };
  });
};

const formatResult = (result, conditions) => {
  if (result.error) return `  ✗ ${result.error}`;
  const [row] = result.rows;
  const parts = conditions.columns
    .filter((column) => column.source === "ai" && column.type === "enum")
    .map((column) => `${column.label}: ${row[column.key]}`);
  parts.push(`確信度: ${row.confidence}`);
  if (row.needsReview) parts.push(row.needsReview);
  return [
    `  → ${parts.join(" / ")}`,
    ...result.warnings.map((warning) => `  ! ${warning}`),
  ].join("\n");
};

export const runRecords = async ({
  conditionsPath,
  inputPath,
  outputPath,
  limit,
  createClient,
  summaryPath,
  elapsedSeconds = () => 0,
}) => {
  const conditions = loadConditions(conditionsPath);
  const records = loadRecords(inputPath).slice(0, limit);
  const inputColumns = conditions.columns.filter(
    (column) => column.source === "input",
  );

  const items = records.map((record) => ({
    id: record.id,
    label: [record.id, record.subject ?? record.title]
      .filter(Boolean)
      .join(" "),
    payload: record,
    passthrough: Object.fromEntries(
      inputColumns.map((column) => [column.key, record[column.key] ?? ""]),
    ),
  }));

  const client = createClient();
  console.log(`条件: ${conditions.name}（${conditionsPath}）`);
  console.log(`入力: ${items.length}件（${inputPath}）`);

  const columns = outputColumns(conditions);
  const results = await runJudge({
    items,
    conditions,
    client,
    onResult: (result, all) => {
      console.log(`\n[${result.position}] ${result.item.label}`);
      console.log(formatResult(result, conditions));
      writeCsv(
        outputPath,
        columns,
        all.flatMap((r) => r.rows),
      );
    },
  });

  const rows = results.flatMap((result) => result.rows);
  const review = rows.filter((row) => row.needsReview).length;
  console.log(`\n判定 ${rows.length}件（うち要確認 ${review}件）`);

  const durationSeconds = elapsedSeconds();
  const outputs = [outputPath];
  if (summaryPath) {
    const modeLabel =
      client.mode === "sample"
        ? "サンプル実行（AIのAPIは呼んでいません）"
        : `AI判定（モデル: ${client.model}）`;
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(
      summaryPath,
      buildRecordsSummaryMarkdown({
        rows,
        conditions,
        modeLabel,
        durationSeconds,
      }),
    );
    outputs.push(summaryPath);
  }

  return {
    durationSeconds,
    usage: client.usage,
    failures: results
      .filter((result) => result.error)
      .map((result) => result.error),
    outputs,
  };
};
