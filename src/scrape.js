import fs from "fs/promises";
import fetch from "node-fetch";

const URL = "https://www.news-osip.by/raspisanie-transporta/avtobusy-budnie-dni";

function cleanText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeStopName(raw) {
  return String(raw || "")
    .replace(/[:：].*$/, "")
    .replace(/\s*\[.*?\]\s*/g, " ")
    .replace(/Отправление с других.*$/i, "")
    .replace(/Отличается расписание.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeChunk(s) {
  return String(s || "")
    .replace(/\s*[:]\s*/g, ":")
    .replace(/\s*[;]\s*/g, "; ")
    .replace(/\s*[.]\s*/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseStops(text) {
  const parts = text.split(/Отправление с остановки\s+/gi).slice(1);
  const stops = {};

  for (const part of parts) {
    const lines = part.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;

    const stopName = normalizeStopName(lines[0]);
    if (!stopName) continue;

    const body = lines.slice(1).join(" ");

    // extract route blocks: "7 — ..." / "12А - ..." until next route block
    const routeRe = /(\d{1,2}[А-ЯA-Z]?\s*[—-]\s*[^0-9][\s\S]*?)(?=\s+\d{1,2}[А-ЯA-Z]?\s*[—-]\s*[^0-9]|$)/g;
    let chunks = [...body.matchAll(routeRe)].map((m) => normalizeChunk(m[1]));

    if (!chunks.length && body) chunks = [normalizeChunk(body)];

    // drop obvious garbage fragments
    chunks = chunks.filter((s) => s.length > 12 && /\d{1,2}[А-ЯA-Z]?\s*[—-]/.test(s));

    if (!stops[stopName]) stops[stopName] = [];
    for (const ch of chunks) {
      if (ch.length >= 6 && !stops[stopName].includes(ch)) stops[stopName].push(ch);
    }
  }

  return stops;
}

async function main() {
  const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const html = await res.text();
  const text = cleanText(html);
  const stops = parseStops(text);

  const out = {
    source: URL,
    updatedAt: new Date().toISOString(),
    stops,
  };

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/schedule.json", JSON.stringify(out, null, 2), "utf8");
  console.log(`Saved ${Object.keys(stops).length} stops to data/schedule.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
