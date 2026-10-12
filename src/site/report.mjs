const SEVERITY_ORDER = { 高: 0, 中: 1, 低: 2 };

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const table = (header, rows) => [
  `| ${header.join(" | ")} |`,
  `| ${header.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
];

const bySeverity = (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);

export const buildSummaryMarkdown = ({ rows, pages, modeLabel, checkedOn }) => {
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
    ...(high.length ? high.map((row) => `- **${row.check_type}**（${row.page_url}）: ${row.detail}`) : ["- なし"]),
    "",
    "## 要確認（確信度が低い、または判定に失敗した項目）",
    "",
    ...(review.length ? review.map((row) => `- ${row.check_type || "判定失敗"}（${row.page_url}）: ${row.detail || row.reason}`) : ["- なし"]),
    "",
    "## ページ別の検出内容",
  ];

  const pageUrls = [...new Set([...pages.map((page) => page.url), ...findings.map((row) => row.page_url)])];
  for (const url of pageUrls) {
    const pageRows = findings.filter((row) => row.page_url === url).sort(bySeverity);
    lines.push("", `### ${url}`, "");
    if (pageRows.length === 0) {
      lines.push("問題は検出されませんでした。");
      continue;
    }
    lines.push(
      ...table(
        ["重要度", "チェック種別", "検出方法", "内容", "確信度"],
        pageRows.map((row) => [row.severity, row.check_type, row.detection, row.detail, row.confidence]),
      ),
    );
  }

  if (failures.length) {
    lines.push("", "## 判定に失敗した項目", "", ...failures.map((row) => `- ${row.page_url}: ${row.reason}`));
  }
  return `${lines.join("\n")}\n`;
};
