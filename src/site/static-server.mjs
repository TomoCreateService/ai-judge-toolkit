import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { FatalError } from "../ai-client.mjs";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export const startStaticServer = ({ dir, port }) =>
  new Promise((resolveServer, reject) => {
    const root = resolve(dir);
    const server = createServer(async (req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const file = resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
      if (!file.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(req.method === "HEAD" ? undefined : body);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
      }
    });
    server.once("error", (error) => {
      reject(error.code === "EADDRINUSE" ? new FatalError(`ポート ${port} が使用中のため、デモ用サイトを起動できません`) : error);
    });
    server.listen(port, "127.0.0.1", () => resolveServer(server));
  });
