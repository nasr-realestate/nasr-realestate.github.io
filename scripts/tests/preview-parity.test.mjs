// Tests: تكافؤ روابط المعاينة المحلية (server.js) مع روابط Jekyll الإنتاجية.
//
// سبب وجود الاختبار: Jekyll ينشر وثيقة المجموعة على /properties/<slug من الـfront
// matter>/، بينما كان server.js يبني الرابط من اسم الملف. 58 ملفًا من 103 لها
// slug مختلف عن اسم الملف، فكانت المعاينة تعطي 404 لروابط إنتاجية سليمة.
//
// هذا الاختبار:
//   • يفتح التطبيق على منفذ عشوائي (لا 3000، ولا تعارض مع خادم المطور)؛
//   • يتحقق أن كل عقار وطلب يُخدَم على رابطه الإنتاجي (front-matter slug)؛
//   • يزحف الروابط الداخلية في الصفحات العامة ويؤكد 0 روابط مكسورة.
//
// التشغيل: node --test scripts/tests/preview-parity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { app } from "../../server.js";
import { parseFrontMatter } from "../lib/front-matter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise((resolve) => server.close(resolve)));

function frontSlug(dir, file) {
  const { data } = parseFrontMatter(fs.readFileSync(path.join(ROOT, dir, file), "utf8"));
  return String(data.slug || "").trim() || file.replace(/\.md$/, "");
}

async function get(pathname) {
  const res = await fetch(BASE + pathname, { redirect: "follow" });
  const body = await res.text();
  return { status: res.status, body, type: res.headers.get("content-type") || "" };
}

test("كل عقار يُخدَم على رابطه الإنتاجي (front-matter slug) وعلى اسم الملف كـalias", async () => {
  const files = fs.readdirSync(path.join(ROOT, "_properties")).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 100, `عدد العقارات غير متوقع: ${files.length}`);
  const failures = [];
  for (const file of files) {
    const slug = frontSlug("_properties", file);
    const fileSlug = file.replace(/\.md$/, "");
    for (const candidate of new Set([slug, fileSlug])) {
      const r = await get(`/properties/${encodeURIComponent(candidate)}/`);
      if (r.status !== 200) failures.push(`${file}: /properties/${candidate}/ → ${r.status}`);
    }
  }
  assert.deepEqual(failures, [], "روابط معاينة لا تطابق Jekyll");
});

test("الطلب الحالي يُخدَم على slug الـfront matter (وليس اسم الملف)", async () => {
  const files = fs.readdirSync(path.join(ROOT, "_requests")).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const slug = frontSlug("_requests", file);
    const r = await get(`/requests/${encodeURIComponent(slug)}/`);
    assert.equal(r.status, 200, `${file}: /requests/${slug}/`);
  }
});

test("ai-feed.json المنشور يحمل source_path + source_sha256 لكل وحدة (عقد مزامنة D1)", async () => {
  const r = await get("/ai-feed.json");
  assert.equal(r.status, 200);
  const feed = JSON.parse(r.body);
  const files = fs.readdirSync(path.join(ROOT, "_properties")).filter((f) => f.endsWith(".md"));
  assert.equal(feed.properties.length, files.length, "عدد وحدات الـfeed يجب أن يساوي عدد الملفات");
  assert.equal(feed.total_count, files.length);
  const seen = new Set();
  for (const prop of feed.properties) {
    const src = String(prop.source_path || "");
    assert.match(src, /^_properties\/[^/]+\.md$/, `source_path غير صالح: ${prop.slug} → ${src}`);
    assert.ok(!seen.has(src), `source_path مكرر: ${src}`);
    seen.add(src);
    const raw = fs.readFileSync(path.join(ROOT, src), "utf8");
    assert.equal(prop.source_sha256, createHash("sha256").update(raw, "utf8").digest("hex"),
      `source_sha256 لا يطابق الملف: ${src}`);
  }
  assert.equal(seen.size, files.length);
});

test("زحف الروابط الداخلية: 0 روابط مكسورة", async () => {
  const seeds = [
    "/", "/properties/", "/requests/", "/agent.html", "/add-your-property.html",
    "/about-us.html", "/contact-us.html", "/luxury-gallery.html", "/property-images.html",
    "/privacy-policy.html", "/notifications.html", "/tools/valuation.html",
    "/ai-feed.json", "/llms.txt", "/llms-full.txt", "/api/properties.json",
    "/.well-known/mcp.json", "/mcp.json", "/sw.js", "/assets/css/style.min.css",
  ];
  const origin = new URL(BASE).origin;
  const seen = new Set(seeds);
  const queue = [...seeds];
  const broken = [];

  while (queue.length) {
    const page = queue.shift();
    let res;
    try {
      res = await fetch(BASE + page, { redirect: "follow" });
    } catch (err) {
      broken.push(`${page} → ${err.message}`);
      continue;
    }
    const type = res.headers.get("content-type") || "";
    if (!res.ok) { broken.push(`${page} → ${res.status}`); continue; }
    const body = await res.text();
    if (!type.includes("text/html")) continue;

    // لا نقرأ قوالب JS داخل <script> ولا أنماط <style> — الروابط الفعلية فقط.
    const html = body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");
    for (const m of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const raw = m[1].replace(/&amp;/g, "&").trim();
      if (!raw || raw.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
      let url;
      try { url = new URL(raw, BASE + page); } catch { continue; }
      if (url.origin !== origin) continue; // الأصول الخارجية لا تُزحف
      url.hash = "";
      const key = url.pathname + url.search;
      if (!seen.has(key)) { seen.add(key); queue.push(key); }
    }
  }

  assert.deepEqual(broken, [], `روابط مكسورة في المعاينة: ${broken.slice(0, 10).join(" · ")}`);
  assert.ok(seen.size >= 550, `عدد الروابط المزحوفة أقل من المتوقع: ${seen.size}`);
});

// 2026-10-20 — المعرض المرقّم وبيانات البحث في المعاينة كما في Jekyll.
test("المعاينة: /properties/ وصفحات الترقيم وبيانات البحث تُخدَم مثل Jekyll", async () => {
  const facets = JSON.parse(fs.readFileSync(path.join(ROOT, "_data/listing_facets.json"), "utf8"));
  const { per_page: per, total_pages: pages, order } = facets.catalog;
  const seen = new Set();
  for (let n = 1; n <= pages; n += 1) {
    const r = await get(n === 1 ? "/properties/" : `/properties/page/${n}/`);
    assert.equal(r.status, 200, `page ${n}`);
    const slugs = [...r.body.matchAll(/class="pl-card" data-slug="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(slugs, order.slice((n - 1) * per, n * per), `ترتيب/محتوى الصفحة ${n}`);
    slugs.forEach((s) => seen.add(s));
  }
  assert.equal(seen.size, order.length, "كل عقار داخل مدينة نصر يظهر في صفحة واحدة");
  const data = await get("/assets/data/catalog.json");
  assert.equal(data.status, 200);
  const rows = JSON.parse(data.body);
  assert.equal(rows.length, order.length);
  assert.deepEqual(rows.map((x) => x.u.split("/")[2]), order);
});
