const SEVERITY_ORDER = { 高: 0, 中: 1, 低: 2 };

export const PAGE_SEPARATOR = " ↔ ";

const cell = (value) =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

const table = (header, rows) => [
  `| ${header.join(" | ")} |`,
  `| ${header.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
];

const bySeverity = (a, b) =>
  (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);

export const buildSummaryMarkdown = ({
  rows,
  pages,
  modeLabel,
  checkedOn,
  durationSeconds,
}) => {
  const findings = rows.filter((row) => row.check_type);
  const failures = rows.filter((row) => !row.check_type);
  const review = rows.filter((row) => row.needsReview);
  const high = findings.filter((row) => row.severity === "高");

  const counts = new Map();
  for (const row of findings) {
    const key = `${row.check_type}\u0000${row.detection}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const lines = [
    "# サイト定期チェック 要約レポート",
    "",
    `- チェック日: ${checkedOn}`,
    `- 実行モード: ${modeLabel}`,
    `- 処理時間：${durationSeconds}秒`,
    `- 対象ページ: ${pages.length}ページ（取得できたページ ${pages.filter((p) => p.ok).length}）`,
    `- 検出件数: ${findings.length}件（重要度「高」${high.length}件 / 要確認 ${review.length}件）`,
    "",
    "> この結果は自動チェックによるものです。AIが判定した項目には誤りが含まれる可能性があります。修正するかどうかは、担当者が実際のページを確認してから判断してください。",
    "",
    "## 件数の内訳",
    "",
    ...table(
      ["チェック種別", "検出方法", "件数"],
      [...counts].map(([key, count]) => [...key.split("\u0000"), count]),
    ),
    "",
    "## 重要度「高」の項目",
    "",
    ...(high.length
      ? high.map(
          (row) => `- **${row.check_type}**（${row.page_url}）: ${row.detail}`,
        )
      : ["- なし"]),
    "",
    "## 要確認（確信度が低い、または判定に失敗した項目）",
    "",
    ...(review.length
      ? review.map(
          (row) =>
            `- ${row.check_type || "判定失敗"}（${row.page_url}）: ${row.detail || row.reason}`,
        )
      : ["- なし"]),
    "",
  ];

  const crossRows = findings
    .filter((row) => row.page_url.includes(PAGE_SEPARATOR))
    .sort(bySeverity);
  if (crossRows.length) {
    lines.push(
      "## 複数ページにまたがる項目",
      "",
      ...table(
        ["ページ", "重要度", "チェック種別", "検出方法", "内容", "確信度"],
        crossRows.map((row) => [
          row.page_url,
          row.severity,
          row.check_type,
          row.detection,
          row.detail,
          row.confidence,
        ]),
      ),
      "",
    );
  }
  lines.push("## ページ別の検出内容");

  const singleRows = findings.filter(
    (row) => !row.page_url.includes(PAGE_SEPARATOR),
  );
  const pageUrls = [
    ...new Set([
      ...pages.map((page) => page.url),
      ...singleRows.map((row) => row.page_url),
    ]),
  ];
  for (const url of pageUrls) {
    const pageRows = singleRows
      .filter((row) => row.page_url === url)
      .sort(bySeverity);
    lines.push("", `### ${url}`, "");
    if (pageRows.length === 0) {
      const related = crossRows.some((row) =>
        row.page_url.split(PAGE_SEPARATOR).includes(url),
      );
      lines.push(
        related
          ? "このページだけの問題は検出されませんでした（ほかのページとの食い違いは「複数ページにまたがる項目」を参照）。"
          : "問題は検出されませんでした。",
      );
      continue;
    }
    lines.push(
      ...table(
        ["重要度", "チェック種別", "検出方法", "内容", "確信度"],
        pageRows.map((row) => [
          row.severity,
          row.check_type,
          row.detection,
          row.detail,
          row.confidence,
        ]),
      ),
    );
  }

  if (failures.length) {
    lines.push(
      "",
      "## 判定に失敗した項目",
      "",
      ...failures.map((row) => `- ${row.page_url}: ${row.reason}`),
    );
  }
  return `${lines.join("\n")}\n`;
};

export const buildRecordsSummaryMarkdown = ({
  rows,
  conditions,
  modeLabel,
  durationSeconds,
}) => {
  const categories =
    conditions.columns.find((column) => column.key === "category")?.values ??
    [];
  const review = rows.filter((row) => row.needsReview);
  const failed = rows.filter((row) => !row.category);
  return [
    "# 問い合わせ仕分け 要約レポート",
    "",
    `- 実行モード: ${modeLabel}`,
    `- 処理時間：${durationSeconds}秒`,
    `- 処理件数: ${rows.length}件（要確認 ${review.length}件 / 判定失敗 ${failed.length}件）`,
    "",
    "## 分類ごとの件数",
    "",
    ...table(
      ["分類", "件数"],
      categories.map((category) => [
        category,
        rows.filter((row) => row.category === category).length,
      ]),
    ),
    "",
    "## 要確認のメール",
    "",
    ...(review.length
      ? review.map(
          (row) =>
            `- ${row.subject}（${row.confidence === "低" ? "確信度が低い" : row.category ? "文字数上限による切り詰め" : "判定失敗"}）: ${row.reason}`,
        )
      : ["- なし"]),
    "",
  ].join("\n");
};
