import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import { FatalError } from "./ai-client.mjs";

const SOURCE_ALIASES = { ai: "ai", AI: "ai", 入力: "input", input: "input" };

const fail = (path, message) => {
  throw new FatalError(`条件ファイル ${path} の読み込みに失敗: ${message}`);
};

const normalizeColumn = (path, column, index) => {
  const where = `出力項目の${index + 1}番目`;
  if (!column.key) fail(path, `${where}に key がありません`);
  if (!column.label) fail(path, `${where}（${column.key}）に label がありません`);
  const source = SOURCE_ALIASES[column.source ?? "ai"];
  if (!source) fail(path, `${where}（${column.key}）の source は "ai" か "input" にしてください`);
  const type = column.type ?? "text";
  if (type === "enum" && !(Array.isArray(column.values) && column.values.length > 0)) {
    fail(path, `${where}（${column.key}）は enum なので values に選択肢を指定してください`);
  }
  if (!["text", "enum"].includes(type)) fail(path, `${where}（${column.key}）の type は "text" か "enum" にしてください`);
  return {
    key: column.key,
    label: column.label,
    source,
    type,
    values: type === "enum" ? column.values : undefined,
    maxLength: column.maxLength ? Number(column.maxLength) : undefined,
    description: column.description ?? "",
  };
};

const finalize = (path, { name, instructions, output, columns }) => {
  if (!instructions?.trim()) fail(path, "判定の指示（instructions）が空です");
  if (!Array.isArray(columns) || columns.length === 0) fail(path, "出力項目（columns）がありません");
  const normalized = columns.map((column, i) => normalizeColumn(path, column, i));
  if (!normalized.some((column) => column.source === "ai")) fail(path, "AIが判定する項目（source: ai）が1つもありません");
  if (output === "rows" && normalized.some((column) => column.source === "input")) {
    fail(path, "output が rows のときは、入力から転記する項目（source: input）は使えません");
  }
  return { path, name: name || basename(path), instructions: instructions.trim(), output: output === "rows" ? "rows" : "row", columns: normalized };
};

const parseJson = (path, text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    fail(path, `JSONの形式が正しくありません（${error.message}）`);
  }
  const instructions = Array.isArray(data.instructions) ? data.instructions.join("\n") : data.instructions;
  return finalize(path, { ...data, instructions });
};

const parseFormat = (format) => {
  const enumMatch = format.match(/^選択肢\s*[:：]\s*(.+)$/);
  if (enumMatch) return { type: "enum", values: enumMatch[1].split("/").map((v) => v.trim()).filter(Boolean) };
  const lengthMatch = format.match(/(\d+)\s*文字以内/);
  return { type: "text", maxLength: lengthMatch ? Number(lengthMatch[1]) : undefined };
};

const parseMarkdown = (path, text) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const name = lines.find((line) => line.startsWith("# "))?.slice(2).trim();
  const start = lines.findIndex((line) => /^##\s+出力項目/.test(line));
  if (start === -1) fail(path, "「## 出力項目」の見出しがありません");
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;

  const output = /複数行/.test(lines[start]) ? "rows" : "row";
  const rows = lines
    .slice(start + 1, end)
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  if (rows.length < 2) fail(path, "「## 出力項目」の表が見つかりません");

  const [header, ...body] = rows;
  const index = (label) => header.indexOf(label);
  for (const label of ["キー", "見出し", "取得元", "形式"]) {
    if (index(label) === -1) fail(path, `出力項目の表に「${label}」列がありません`);
  }
  const columns = body.map((cells) => ({
    key: cells[index("キー")],
    label: cells[index("見出し")],
    source: cells[index("取得元")],
    description: index("説明") === -1 ? "" : cells[index("説明")],
    ...parseFormat(cells[index("形式")]),
  }));

  const instructions = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  return finalize(path, { name, instructions, output, columns });
};

export const loadConditions = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    fail(path, error.code === "ENOENT" ? "ファイルが見つかりません" : error.message);
  }
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return parseJson(path, text);
  if (ext === ".md") return parseMarkdown(path, text);
  return fail(path, "拡張子は .json か .md にしてください");
};
