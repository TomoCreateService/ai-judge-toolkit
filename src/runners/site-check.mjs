import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FatalError } from "../ai-client.mjs";
import { loadConditions } from "../conditions.mjs";
import { writeCsv } from "../csv.mjs";
import { outputColumns, runJudge } from "../engine.mjs";
import { fetchPage, findBrokenResources } from "../site/crawler.mjs";
import { PAGE_SEPARATOR, buildSummaryMarkdown } from "../site/report.mjs";
import { startStaticServer } from "../site/static-server.mjs";

const FIXTURE_PORT = 4173;
const REQUIRED_KEYS = ["page_url", "check_type", "detail", "severity"];
const PROGRAM_REASON = "プログラムで実際にアクセスして確認した結果";

const loadUrls = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    throw new FatalError(
      `URL一覧 ${path} を読み込めません（${error.code === "ENOENT" ? "ファイルが見つかりません" : error.message}）`,
    );
  }
  const urls = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const [i, url] of urls.entries()) {
    if (!URL.canParse(url))
      throw new FatalError(
        `URL一覧 ${path} の${i + 1}件目「${url}」がURLとして正しくありません`,
      );
  }
  if (urls.length === 0)
    throw new FatalError(`URL一覧 ${path} にURLがありません`);
  return urls;
};

const programRow = ({ pageUrl, checkType, detail, severity }) => ({
  page_url: pageUrl,
  detection: "プログラム",
  check_type: checkType,
  detail,
  severity,
  reason: PROGRAM_REASON,
  confidence: "高",
  needsReview: "",
});

const normalizePageUrl = (value, pageUrls) => {
  const urls = [...new Set(value.match(/https?:\/\/[^\s↔,、]+/g) ?? [])];
  if (urls.length < 2) return value;
  const order = (url) =>
    pageUrls.includes(url) ? pageUrls.indexOf(url) : Infinity;
  return urls.sort((a, b) => order(a) - order(b)).join(PAGE_SEPARATOR);
};

const singlePageName = (pageUrl) => {
  if (!URL.canParse(pageUrl)) return pageUrl;
  const { host, pathname } = new URL(pageUrl);
  return pathname.split("/").filter(Boolean).at(-1) ?? host;
};

const pageName = (pageUrl) =>
  pageUrl.split(PAGE_SEPARATOR).map(singlePageName).join(PAGE_SEPARATOR);

const today = () => new Date().toLocaleDateString("sv-SE");

export const runSiteCheck = async ({
  root,
  conditionsPath,
  inputPath,
  outputPath,
  summaryPath,
  limit,
  serveFixtures,
  createClient,
  elapsedSeconds = () => 0,
}) => {
  const conditions = loadConditions(conditionsPath);
  const missing = REQUIRED_KEYS.filter(
    (key) => !conditions.columns.some((column) => column.key === key),
  );
  if (conditions.output !== "rows" || missing.length) {
    throw new FatalError(
      `サイトチェック用の条件ファイルは output: "rows" で、項目 ${REQUIRED_KEYS.join(" / ")} が必要です（不足: ${missing.join(", ") || "なし"}）`,
    );
  }
  const urls = loadUrls(inputPath).slice(0, limit);
  const checkedOn = today();
  const client = createClient();

  const server = serveFixtures
    ? await startStaticServer({
        dir: join(root, "tests/fixtures/site"),
        port: FIXTURE_PORT,
      })
    : null;
  if (server)
    console.log(
      `デモ用サイトを http://localhost:${FIXTURE_PORT}/ で起動しました`,
    );

  try {
    console.log(`\n[1/3] ページ取得（${urls.length}ページ）`);
    const pages = [];
    for (const url of urls) {
      const page = await fetchPage(url);
      pages.push(page);
      console.log(
        page.ok
          ? `  ✓ ${url}（${page.text.length}文字）`
          : `  ✗ ${url} の取得に失敗: ${page.error}`,
      );
      if (page.truncated)
        console.log(`  ! ${url} の本文が長いため先頭のみAIに渡します`);
    }

    console.log("\n[2/3] リンク切れ・画像切れのチェック（プログラム）");
    const broken = await findBrokenResources(pages);
    const programRows = [
      ...pages
        .filter((page) => !page.ok)
        .map((page) =>
          programRow({
            pageUrl: page.url,
            checkType: "ページ取得失敗",
            detail: `ページを取得できません（${page.error}）`,
            severity: "高",
          }),
        ),
      ...broken.map((item) =>
        programRow({
          pageUrl: item.pageUrl,
          checkType: item.kind === "link" ? "リンク切れ" : "画像切れ",
          detail:
            item.kind === "link"
              ? `リンク「${item.text || "（テキストなし）"}」の遷移先 ${item.target} が ${item.problem}`
              : `画像 ${item.target}（alt: ${item.text || "なし"}）が ${item.problem}`,
          severity: "中",
        }),
      ),
    ];
    for (const row of programRows)
      console.log(
        `  ✗ [${pageName(row.page_url)}] ${row.check_type}: ${row.detail}`,
      );
    if (programRows.length === 0) console.log("  問題なし");

    console.log("\n[3/3] 内容のチェック（AI）");
    const fetched = pages.filter((page) => page.ok);
    const items = fetched.length
      ? [
          {
            id: "site",
            label: `${fetched.length}ページの横断チェック`,
            payload: {
              checked_on: checkedOn,
              pages: fetched.map(({ url, title, text }) => ({
                url,
                title,
                text,
              })),
            },
            passthrough: { page_url: "（全ページ）", detection: "AI" },
          },
        ]
      : [];
    const results = await runJudge({ items, conditions, client });
    const fetchedUrls = fetched.map((page) => page.url);
    const aiRows = results.flatMap((result) =>
      result.rows.map((row) => ({
        ...row,
        page_url: normalizePageUrl(row.page_url, fetchedUrls),
        detection: "AI",
      })),
    );
    for (const result of results) {
      if (result.error) console.log(`  ✗ ${result.error}`);
      for (const warning of result.warnings) console.log(`  ! ${warning}`);
    }
    for (const row of aiRows.filter((r) => r.check_type)) {
      console.log(
        `  → [${pageName(row.page_url)}] ${row.check_type}（重要度 ${row.severity} / 確信度 ${row.confidence}${row.needsReview ? ` / ${row.needsReview}` : ""}）: ${row.detail}`,
      );
    }

    const columns = outputColumns(conditions);
    const pageUrlIndex = columns.findIndex(
      (column) => column.key === "page_url",
    );
    columns.splice(pageUrlIndex + 1, 0, {
      key: "detection",
      label: "検出方法",
    });
    const rows = [...programRows, ...aiRows];
    writeCsv(outputPath, columns, rows);

    const durationSeconds = elapsedSeconds();
    const modeLabel =
      client.mode === "sample"
        ? "サンプル実行（AIのAPIは呼んでいません）"
        : `AI判定（モデル: ${client.model}）`;
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(
      summaryPath,
      buildSummaryMarkdown({
        rows,
        pages,
        modeLabel,
        checkedOn,
        durationSeconds,
      }),
    );

    return {
      durationSeconds,
      usage: client.usage,
      failures: results.filter((r) => r.error).map((r) => r.error),
      outputs: [outputPath, summaryPath],
    };
  } finally {
    server?.close();
  }
};
