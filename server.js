const express = require("express");
const cheerio = require("cheerio");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------------------------------- jobs ---------------------------------- */

const jobs = new Map();
let nextJobId = 1;
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_RUN_MS = 45 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "running" && now - job.startedAt > MAX_RUN_MS) job.cancelled = true;
    if (job.status !== "running" && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60 * 1000).unref();

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------- url helpers ------------------------------ */

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|gbraid|wbraid|mc_cid|mc_eid|igshid|msclkid|yclid|vero_id|wickedid|ttclid|_ga|_gl)$/i;

function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    u.username = "";
    u.password = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "https:" && u.port === "443") ||
        (u.protocol === "http:" && u.port === "80")) u.port = "";
    // Strip tracking parameters so the same page is not crawled twice.
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    return u.toString();
  } catch { return null; }
}

function isPageLike(url) {
  const path = new URL(url).pathname.toLowerCase();
  return !/\.(?:jpg|jpeg|png|gif|webp|svg|ico|bmp|avif|css|js|mjs|map|pdf|zip|rar|7z|tar|gz|mp3|wav|ogg|mp4|webm|avi|mov|m4v|woff2?|ttf|eot|otf|docx?|xlsx?|pptx?|ics|vcf|apk|exe|dmg|iso|xml|json|txt|csv)$/i.test(path);
}

function sameHost(a, b) {
  try { return new URL(a).hostname === new URL(b).hostname; } catch { return false; }
}

/* --------------------------------- fetching ------------------------------- */

function decodeBody(buf, contentType) {
  let charset = /charset=["']?([\w.-]+)/i.exec(contentType || "")?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString("latin1");
    charset = /<meta[^>]+charset=["']?\s*([\w.-]+)/i.exec(head)?.[1];
  }
  try { return new TextDecoder(charset || "utf-8").decode(buf); }
  catch { return new TextDecoder("utf-8").decode(buf); }
}

async function fetchRaw(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || 15000);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "SiteCrawler/2.0 (+same-domain website audit)",
        "Accept": "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "ar,en;q=0.8"
      }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf, timeMs: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

function gunzipIfNeeded(buf, url, res) {
  const enc = (res.headers.get("content-encoding") || "").toLowerCase();
  if (enc.includes("gzip") || /\.gz$/i.test(new URL(url).pathname)) {
    try { return zlib.gunzipSync(buf); } catch { /* fall through */ }
  }
  return buf;
}

function classifyError(e) {
  const code = (e && (e.cause?.code || e.code)) || "";
  if (e.name === "AbortError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "انتهت مهلة الاتصال";
  if (code === "ENOTFOUND") return "النطاق غير موجود (DNS)";
  if (code === "ECONNREFUSED") return "تم رفض الاتصال";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return "انقطع الاتصال";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "تعذّر الوصول للخادم";
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(code)) return "خطأ في شهادة الأمان";
  if (/redirect/i.test(e.message || "")) return "سلسلة تحويلات طويلة";
  if (e.message === "fetch failed") return "فشل الاتصال بالخادم";
  return e.message || "خطأ غير معروف";
}

/* -------------------------------- robots.txt ------------------------------ */

function robotsRuleRegex(rulePath) {
  // Google-style matching: * = any sequence, $ at end = exact end.
  let anchored = false;
  let p = rulePath;
  if (p.endsWith("$")) { anchored = true; p = p.slice(0, -1); }
  const parts = p.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return { re: new RegExp("^" + parts.join(".*") + (anchored ? "$" : "")), len: p.replace(/\*/g, "").length };
}

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ type: key, path: value });
    } else if (key === "sitemap" && value) {
      sitemaps.push(value);
    }
  }
  // Pick the most specific matching group for our bot.
  const BOT = "sitecrawler";
  let best = null, bestScore = -1;
  for (const g of groups) {
    const s = Math.max(...g.agents.map(a => a === "*" ? 0 : (BOT.includes(a) || a.includes(BOT) ? a.length : -1)));
    if (s > bestScore) { bestScore = s; best = g; }
  }
  const rules = (best ? best.rules : [])
    .filter(r => r.path)
    .map(r => ({ ...r, ...robotsRuleRegex(r.path) }));
  const allowed = (url) => {
    try {
      const p = new URL(url).pathname;
      let win = null;
      for (const r of rules) {
        if (!r.re.test(p)) continue;
        if (!win || r.len > win.len || (r.len === win.len && r.type === "allow")) win = r;
      }
      return !win || win.type === "allow";
    } catch { return true; }
  };
  return { allowed, sitemaps };
}

async function getRobots(startUrl) {
  const origin = new URL(startUrl).origin;
  try {
    const { res, buf } = await fetchRaw(origin + "/robots.txt", 10000);
    if (!res.ok) return { allowed: () => true, sitemaps: [] };
    const parsed = parseRobots(decodeBody(buf, res.headers.get("content-type") || ""));
    parsed.sitemaps = parsed.sitemaps
      .map(s => normalizeUrl(s, origin))
      .filter(u => u && sameHost(u, origin));
    return parsed;
  } catch {
    return { allowed: () => true, sitemaps: [] };
  }
}

/* --------------------------------- sitemaps ------------------------------- */

async function parseSitemap(url, seenMaps) {
  if (seenMaps.has(url)) return [];
  seenMaps.add(url);
  try {
    const { res, buf } = await fetchRaw(url, 15000);
    if (!res.ok) return [];
    const text = gunzipIfNeeded(buf, url, res).toString("utf-8");
    const $ = cheerio.load(text, { xmlMode: true });
    const out = [];
    $("sitemap > loc, sitemap > link").each((_, el) => {
      const child = $(el).text().trim();
      if (child) out.push({ type: "sitemap", url: child });
    });
    $("url > loc").each((_, el) => {
      const child = $(el).text().trim();
      if (child) out.push({ type: "url", url: child });
    });
    return out;
  } catch { return []; }
}

async function discoverSitemapUrls(startUrl, robotsSitemaps, cap) {
  const origin = new URL(startUrl).origin;
  const candidates = [...new Set([
    ...robotsSitemaps,
    origin + "/sitemap.xml",
    origin + "/sitemap_index.xml",
    origin + "/sitemap.xml.gz",
    origin + "/wp-sitemap.xml"
  ])];
  const urls = [];
  const seenMaps = new Set();
  const queue = [...candidates];
  const cap40 = 40;
  let done = false;
  // Fetch sitemap files in parallel so large sites don't block the crawl.
  async function mapWorker() {
    while (queue.length && seenMaps.size < cap40 && !done) {
      const item = queue.shift();
      if (!item || seenMaps.has(item)) continue;
      const entries = await parseSitemap(item, seenMaps);
      for (const e of entries) {
        if (e.type === "sitemap" && seenMaps.size + queue.length < cap40) queue.push(e.url);
        else if (e.type === "url") urls.push(e.url);
      }
      if (urls.length >= cap) done = true;
    }
  }
  await Promise.all(Array.from({ length: 4 }, mapWorker));
  return [...new Set(urls.map(u => normalizeUrl(u, startUrl)).filter(Boolean))];
}

/* ---------------------------------- crawl --------------------------------- */

function extractPage($, pageUrl) {
  const title = $("title").first().text().trim().replace(/\s+/g, " ").slice(0, 300);
  const description = ($('meta[name="description" i]').attr("content") || "").trim().replace(/\s+/g, " ").slice(0, 400);
  const h1 = $("h1").first().text().trim().replace(/\s+/g, " ").slice(0, 200);
  const robotsMeta = ($('meta[name="robots" i]').attr("content") || "").toLowerCase();
  const canonical = normalizeUrl($('link[rel="canonical" i]').attr("href") || "", pageUrl) || "";
  const lang = ($("html").attr("lang") || "").trim().slice(0, 20);

  let internal = 0, external = 0;
  const found = [];
  $("a[href]").each((_, el) => {
    const u = normalizeUrl($(el).attr("href"), pageUrl);
    if (!u) return;
    if (sameHost(u, pageUrl)) internal++; else external++;
    found.push(u);
  });
  // hreflang alternates often point to pages not linked in the body.
  $("link[rel='alternate'][hreflang]").each((_, el) => {
    const u = normalizeUrl($(el).attr("href"), pageUrl);
    if (u) found.push(u);
  });

  return {
    title, description, h1,
    noindex: /\bnoindex\b/.test(robotsMeta),
    nofollow: /\bnofollow\b/.test(robotsMeta),
    canonical, lang,
    internal, external,
    found: [...new Set(found)]
  };
}

async function crawl(startUrl, settings, job) {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error("الرابط غير صالح.");
  const robots = settings.respectRobots ? await getRobots(start) : { allowed: () => true, sitemaps: [] };

  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const results = [];
  let fromSitemap = 0;

  const enqueue = (url, source) => {
    const u = normalizeUrl(url, start);
    if (!u || !sameHost(u, start) || !isPageLike(u) || !robots.allowed(u)) return false;
    if (visited.has(u) || queued.has(u)) return false;
    if (queued.size + visited.size >= settings.maxPages) return false;
    queued.add(u);
    queue.push({ url: u, source: source || "" });
    return true;
  };

  enqueue(start, "");

  if (settings.useSitemap) {
    job.phase = "قراءة ملفات sitemap…";
    const sitemapUrls = await discoverSitemapUrls(start, robots.sitemaps, settings.maxPages * 4);
    for (const u of sitemapUrls) if (enqueue(u, "sitemap.xml")) fromSitemap++;
    job.fromSitemap = fromSitemap;
  }
  job.phase = "";

  async function worker() {
    while (!job.cancelled) {
      const item = queue.shift();
      if (!item) return;
      queued.delete(item.url);
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      job.current = item.url;
      try {
        const { res, buf, timeMs } = await fetchRaw(item.url, settings.timeout);
        const contentType = res.headers.get("content-type") || "";
        const finalUrl = normalizeUrl(res.url || item.url) || item.url;
        const row = {
          url: item.url,
          finalUrl,
          redirected: res.redirected && finalUrl !== item.url,
          status: res.status,
          statusText: res.statusText || "",
          type: contentType.split(";")[0].trim(),
          timeMs,
          bytes: buf.length,
          title: "", description: "", h1: "", lang: "",
          noindex: false, nofollow: false,
          canonical: "", canonicalMatch: false,
          internal: 0, external: 0,
          source: item.source,
          error: "", errorCode: ""
        };

        if (/html|xhtml/i.test(contentType)) {
          const $ = cheerio.load(decodeBody(buf, contentType));
          const meta = extractPage($, item.url);
          Object.assign(row, {
            title: meta.title, description: meta.description, h1: meta.h1, lang: meta.lang,
            noindex: meta.noindex, nofollow: meta.nofollow,
            canonical: meta.canonical,
            canonicalMatch: !!meta.canonical && meta.canonical === item.url,
            internal: meta.internal, external: meta.external
          });
          for (const u of meta.found) enqueue(u, item.url);
        }
        results.push(row);
      } catch (e) {
        results.push({
          url: item.url, finalUrl: "", redirected: false,
          status: 0, statusText: "", type: "", timeMs: 0, bytes: 0,
          title: "", description: "", h1: "", lang: "",
          noindex: false, nofollow: false, canonical: "", canonicalMatch: false,
          internal: 0, external: 0,
          source: item.source,
          error: classifyError(e),
          errorCode: (e && (e.cause?.code || e.code)) || e.name || ""
        });
      } finally {
        job.done = results.length;
        job.queued = queue.length;
        job.results = results;
      }
      if (settings.delay > 0) await sleep(settings.delay);
    }
  }

  const workers = Array.from({ length: Math.max(1, settings.concurrency) }, worker);
  await Promise.all(workers);
  return results;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase || "",
    done: job.done,
    queued: job.queued || 0,
    fromSitemap: job.fromSitemap || 0,
    maxPages: job.maxPages,
    current: job.current || "",
    target: job.target,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || 0,
    results: job.results || [],
    error: job.error || ""
  };
}

/* --------------------------------- routes --------------------------------- */

app.post("/api/crawl", async (req, res) => {
  try {
    const body = req.body || {};
    const url = normalizeUrl(body.url);
    if (!url) return res.status(400).json({ error: "أدخل رابطاً صحيحاً يبدأ بـ http:// أو https://" });
    const settings = {
      maxPages: Math.min(Math.max(Number(body.maxPages) || 1000, 1), 10000),
      concurrency: Math.min(Math.max(Number(body.concurrency) || 3, 1), 10),
      delay: Math.min(Math.max(Number(body.delay) || 100, 0), 5000),
      timeout: Math.min(Math.max(Number(body.timeout) || 15000, 3000), 60000),
      respectRobots: body.respectRobots !== false,
      useSitemap: body.useSitemap !== false
    };
    const job = {
      id: String(nextJobId++),
      status: "running", done: 0, queued: 0, fromSitemap: 0,
      maxPages: settings.maxPages, current: "", target: url,
      results: [], cancelled: false, error: "",
      startedAt: Date.now(), finishedAt: 0
    };
    jobs.set(job.id, job);
    res.json({ id: job.id });
    crawl(url, settings, job).then(() => {
      job.status = job.cancelled ? "cancelled" : "done";
      job.current = "";
      job.finishedAt = Date.now();
    }).catch(e => {
      job.status = "error";
      job.error = e.message || "حدث خطأ غير معروف";
      job.current = "";
      job.finishedAt = Date.now();
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/crawl/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "العملية غير موجودة." });
  res.json(publicJob(job));
});

app.post("/api/crawl/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "العملية غير موجودة." });
  job.cancelled = true;
  res.json({ ok: true });
});

const CSV_HEADERS = ["url","finalUrl","redirected","status","statusText","timeMs","bytes","type","title","description","h1","lang","noindex","canonical","canonicalMatch","internal","external","source","error"];

app.get("/api/crawl/:id/csv", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Not found");
  const esc = v => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const csv = [CSV_HEADERS.join(","), ...job.results.map(r => CSV_HEADERS.map(h => esc(r[h])).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="crawl-${job.id}.csv"`);
  res.send("\ufeff" + csv);
});

app.get("/api/crawl/:id/json", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="crawl-${job.id}.json"`);
  res.send(JSON.stringify(publicJob(job), null, 2));
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Site Crawler listening on ${PORT}`));
