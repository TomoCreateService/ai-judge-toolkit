import * as cheerio from "cheerio";

const TIMEOUT_MS = 15000;
const MAX_TEXT_LENGTH = 20000;
const BLOCK_ELEMENTS = "p, div, li, dt, dd, th, td, tr, h1, h2, h3, h4, h5, h6, section, article, header, footer, nav, address, time";

const toAbsolute = (value, base) => {
  if (!value || value.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

const extractText = ($) => {
  $("script, style, noscript, svg, template, iframe").remove();
  $("br").replaceWith("\n");
  $(BLOCK_ELEMENTS).append("\n");
  const lines = [];
  for (const line of $("body").text().split("\n").map((l) => l.replace(/\s+/g, " ").trim())) {
    if (line && line !== lines.at(-1)) lines.push(line);
  }
  return lines.join("\n");
};

export const fetchPage = async (url) => {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return { url, ok: false, error: `接続できません（${error.cause?.code ?? error.message}）` };
  }
  if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}` };

  const $ = cheerio.load(await res.text());
  const links = $("a[href]")
    .map((_, el) => ({ target: toAbsolute($(el).attr("href"), res.url), text: $(el).text().trim() }))
    .get()
    .filter((link) => link.target);
  const images = $("img[src]")
    .map((_, el) => ({ target: toAbsolute($(el).attr("src"), res.url), text: $(el).attr("alt") ?? "" }))
    .get()
    .filter((image) => image.target);
  const title = $("title").text().trim();
  const fullText = extractText($);
  const truncated = fullText.length > MAX_TEXT_LENGTH;

  return { url, ok: true, title, text: truncated ? fullText.slice(0, MAX_TEXT_LENGTH) : fullText, truncated, links, images };
};

const probe = async (target) => {
  try {
    let res = await fetch(target, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 405 || res.status === 501) res = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (error) {
    return `接続できません（${error.cause?.code ?? error.message}）`;
  }
};

export const findBrokenResources = async (pages) => {
  const cache = new Map();
  const broken = [];
  for (const page of pages.filter((p) => p.ok)) {
    for (const [kind, resources] of [["link", page.links], ["image", page.images]]) {
      for (const resource of resources) {
        if (!cache.has(resource.target)) cache.set(resource.target, await probe(resource.target));
        const problem = cache.get(resource.target);
        if (problem) broken.push({ pageUrl: page.url, kind, ...resource, problem });
      }
    }
  }
  return broken;
};
