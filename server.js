const express = require("express");
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const jobs = new Map();
let nextJobId = 1;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    u.hash = "";
    u.username = "";
    u.password = "";
    if (!["http:", "https:"].includes(u.protocol)) return null;
    // Normalize common default ports.
    if ((u.protocol === "https:" && u.port === "443") ||
        (u.protocol === "http:" && u.port === "80")) u.port = "";
    return u.toString();
  } catch { return null; }
}

function isPageLike(url) {
  const path = new URL(url).pathname.toLowerCase();
  return !/\.(?:jpg|jpeg|png|gif|webp|svg|ico|bmp|avif|css|js|mjs|map|pdf|zip|rar|7z|tar|gz|mp3|wav|mp4|webm|avi|mov|woff2?|ttf|eot|otf|docx?|xlsx?|pptx?)$/i.test(path);
}

function sameHost(a, b) {
  return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "SiteCrawler/1.0 (+same-domain website audit)",
        "Accept": "text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.5"
      }
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getRobots(startUrl) {
  const origin = new URL(startUrl).origin;
  try {
    const { res, text } = await fetchText(origin + "/robots.txt", { timeout: 10000 });
    if (!res.ok) return { allowed: () => true, sitemaps: [] };
    const lines = text.split(/\r?\n/);
    let applies = false;
    let blocked = [];
    const sitemaps = [];
    for (const line of lines) {
      const clean = line.split("#")[0].trim();
      if (!clean) continue;
      const [key, ...rest] = clean.split(":");
      const value = rest.join(":").trim();
      if (key.toLowerCase() === "user-agent") {
        applies = value === "*" || value.toLowerCase() === "sitecrawler";
        if (value === "*") blocked = [];
      } else if (applies && key.toLowerCase() === "disallow" && value) {
        blocked.push(value);
      } else if (key.toLowerCase() === "sitemap" && value) {
        const u = normalizeUrl(value, origin);
        if (u) sitemaps.push(u);
      }
    }
    const allowed = (url) => {
      try {
        const p = decodeURIComponent(new URL(url).pathname);
        return !blocked.some(rule => {
          const r = rule.trim();
          if (!r) return false;
          if (r.endsWith("$")) return p === r.slice(0, -1);
          return p.startsWith(r);
        });
      } catch { return true; }
    };
    return { allowed, sitemaps };
  } catch {
    return { allowed: () => true, sitemaps: [] };
  }
}

async function parseSitemap(url, seen = new Set()) {
  if (seen.has(url) || seen.size > 20) return [];
  seen.add(url);
  try {
    const { res, text } = await fetchText(url, { timeout: 12000 });
    if (!res.ok) return [];
    const $ = cheerio.load(text, { xmlMode: true });
    const out = [];
    $("sitemap > loc").each((_, el) => {
      const child = $(el).text().trim();
      if (child) out.push({ type: "sitemap", url: child });
    });
    $("url > loc").each((_, el) => {
      const child = $(el).text().trim();
      if (child) out.push({ type: "url", url: child });
    });
    // Some servers return a sitemap index without correct XML headers.
    return out;
  } catch { return []; }
}

async function discoverSitemapUrls(startUrl, robotsSitemaps) {
  const candidates = [...new Set([
    ...robotsSitemaps,
    new URL("/sitemap.xml", startUrl).toString(),
    new URL("/sitemap_index.xml", startUrl).toString()
  ])];
  const urls = [];
  const seenMaps = new Set();
  const queue = candidates.map(url => ({ type: "sitemap", url }));
  while (queue.length && seenMaps.size < 30) {
    const item = queue.shift();
    if (!item.url || seenMaps.has(item.url)) continue;
    seenMaps.add(item.url);
    const entries = await parseSitemap(item.url, seenMaps);
    for (const e of entries) {
      if (e.type === "sitemap") queue.push(e);
      else urls.push(e.url);
    }
  }
  return [...new Set(urls.map(u => normalizeUrl(u, startUrl)).filter(Boolean))];
}

async function crawl(startUrl, settings, job) {
  const start = normalizeUrl(startUrl);
  if (!start) throw new Error("الرابط غير صالح.");
  const originHost = new URL(start).hostname;
  const robots = settings.respectRobots ? await getRobots(start) : { allowed: () => true, sitemaps: [] };

  const queue = [];
  const queued = new Set();
  const visited = new Set();
  const results = [];
  const enqueue = (url, source = null) => {
    const u = normalizeUrl(url, start);
    if (!u || !sameHost(u, start) || !isPageLike(u) || !robots.allowed(u)) return;
    if (visited.has(u) || queued.has(u)) return;
    if (queued.size + visited.size >= settings.maxPages) return;
    queued.add(u);
    queue.push({ url: u, source });
  };

  enqueue(start, null);

  // Sitemaps are useful for pages not linked from the homepage.
  if (settings.useSitemap) {
    const sitemapUrls = await discoverSitemapUrls(start, robots.sitemaps);
    for (const u of sitemapUrls) enqueue(u, "sitemap.xml");
  }

  let active = 0;
  async function worker() {
    while (!job.cancelled) {
      const item = queue.shift();
      if (!item) return;
      queued.delete(item.url);
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      active++;
      job.current = item.url;
      try {
        const { res, text } = await fetchText(item.url, { timeout: settings.timeout });
        const contentType = res.headers.get("content-type") || "";
        const row = {
          url: item.url,
          status: res.status,
          statusText: res.statusText,
          type: contentType.split(";")[0],
          title: "",
          canonical: "",
          links: 0,
          source: item.source || "",
          error: ""
        };

        if (contentType.includes("html") || contentType.includes("xhtml")) {
          const $ = cheerio.load(text);
          row.title = $("title").first().text().trim().replace(/\s+/g, " ").slice(0, 300);
          row.canonical = normalizeUrl($('link[rel="canonical"]').attr("href") || "", item.url) || "";
          const links = [];
          $("a[href], link[rel='alternate'][hreflang]").each((_, el) => {
            const href = $(el).attr("href");
            const u = normalizeUrl(href, item.url);
            if (u) links.push(u);
          });
          const unique = [...new Set(links)];
          row.links = unique.length;
          for (const u of unique) enqueue(u, item.url);
        }
        results.push(row);
        job.done = results.length;
        job.totalQueued = queue.length + queued.size + visited.size;
        job.results = results;
      } catch (e) {
        results.push({
          url: item.url, status: 0, statusText: "", type: "", title: "",
          canonical: "", links: 0, source: item.source || "",
          error: e.name === "AbortError" ? "Timeout" : e.message
        });
        job.done = results.length;
        job.results = results;
      } finally {
        active--;
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
    done: job.done,
    maxPages: job.maxPages,
    current: job.current || "",
    results: job.results || [],
    error: job.error || ""
  };
}

app.post("/api/crawl", async (req, res) => {
  try {
    const body = req.body || {};
    const url = normalizeUrl(body.url);
    if (!url) return res.status(400).json({ error: "أدخل رابطاً صحيحاً يبدأ بـ http:// أو https://" });
    const maxPages = Math.min(Math.max(Number(body.maxPages) || 1000, 1), 10000);
    const concurrency = Math.min(Math.max(Number(body.concurrency) || 3, 1), 10);
    const delay = Math.min(Math.max(Number(body.delay) || 100, 0), 5000);
    const timeout = Math.min(Math.max(Number(body.timeout) || 15000, 3000), 60000);
    const job = {
      id: String(nextJobId++),
      status: "running", done: 0, maxPages, current: "",
      results: [], cancelled: false, error: ""
    };
    jobs.set(job.id, job);
    res.json({ id: job.id });
    crawl(url, { maxPages, concurrency, delay, timeout,
      respectRobots: body.respectRobots !== false,
      useSitemap: body.useSitemap !== false
    }, job).then(() => {
      job.status = job.cancelled ? "cancelled" : "done";
      job.current = "";
    }).catch(e => {
      job.status = "error";
      job.error = e.message || "حدث خطأ غير معروف";
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

app.get("/api/crawl/:id/csv", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Not found");
  const headers = ["url","status","statusText","type","title","canonical","links","source","error"];
  const esc = v => `"${String(v ?? "").replaceAll('"','""')}"`;
  const csv = [headers.join(","), ...job.results.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="crawl-${job.id}.csv"`);
  res.send("\ufeff" + csv);
});

app.get("*", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Site Crawler listening on ${PORT}`));
