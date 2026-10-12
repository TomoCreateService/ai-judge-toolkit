import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "csv-stringify/sync";

const BOM = "﻿";

export const writeCsv = (path, columns, rows) => {
  mkdirSync(dirname(path), { recursive: true });
  const records = rows.map((row) => columns.map((column) => row[column.key] ?? ""));
  writeFileSync(path, BOM + stringify([columns.map((column) => column.label), ...records]));
};
