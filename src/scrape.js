import fs from "fs/promises";
import fetch from "node-fetch";

const SOURCES = {
  weekdays: "https://www.news-osip.by/raspisanie-transporta/avtobusy-budnie-dni",
  weekend: "https://www.news-osip.by/raspisanie-transporta/avtobusy-vyhodnye-dni",
};

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
    // stop/footer garbage from source site
    .replace(/На этой странице[\s\S]*$/i, "")
    .replace(/©\s*20\d{2}[\s\S]*$/i, "")
    // normalize spaced times like "14:0 0" -> "14:00", "0 7:52" -> "07:52"
    .replace(/:\s*0\s+(\d:[0-5]\d)/g, ":0$1")
    .replace(/;\s*0\s+(\d:[0-5]\d)/g, "; 0$1")
    .replace(/(\d)\s*[:]\s*(\d)\s+(\d)/g, "$1:$2$3")
    .replace(/(^|\D)(\d)\s+(\d:\d{2})/g, "$10$2$3")
    .replace(/(^|\D)(\d{1,2}:\d)\s+(\d)(\D|$)/g, "$1$2$3$4")
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

    let body = lines.slice(1).join(" ");
    body = body
      // fix spaced route numbers like "1 2 —" -> "12 —"
      .replace(/\b(\d)\s+(\d)\s*([—-])/g, "$1$2 $3")
      // fix split leading zero times like "0 7:52" -> "07:52"
      .replace(/\b0\D+(\d:[0-5]\d)\b/g, "0$1");

    // split at probable route starts after sentence boundaries; avoids splitting on times like 10:55
    let chunks = body
      .split(/(?=(?:^|[.;])\s*\d{1,2}[А-ЯA-Z]?\s*[—-]\s*[А-ЯA-Zа-я])/g)
      .map((s) => s.replace(/^[.;\s]+/, ""))
      .map((s) => normalizeChunk(s))
      .filter((s) => /^\d{1,2}[А-ЯA-Z]?\s*[—-]/.test(s));

    if (!chunks.length && body) chunks = [normalizeChunk(body)];

    // drop obvious garbage fragments
    chunks = chunks.filter(
      (s) =>
        s.length > 12 &&
        /\d{1,2}[А-ЯA-Z]?\s*[—-]/.test(s) &&
        !/Google\s+Sites|Cookie\s+Policy|Report\s+abuse|новостные материалы|быстрые ссылки/i.test(s)
    );

    if (!stops[stopName]) stops[stopName] = [];
    for (const ch of chunks) {
      if (ch.length >= 6 && !stops[stopName].includes(ch)) stops[stopName].push(ch);
    }
  }

  return stops;
}

async function fetchStops(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Failed: ${res.status} for ${url}`);
  const html = await res.text();
  const text = cleanText(html);
  return parseStops(text);
}

function mergeStops(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [stop, lines] of Object.entries(map || {})) {
      if (!merged[stop]) merged[stop] = [];
      for (const line of lines || []) {
        if (!merged[stop].includes(line)) merged[stop].push(line);
      }
    }
  }
  return merged;
}

async function main() {
  const weekdays = await fetchStops(SOURCES.weekdays);
  const weekend = await fetchStops(SOURCES.weekend);
  const combined = mergeStops(weekdays, weekend);

  const out = {
    sources: SOURCES,
    updatedAt: new Date().toISOString(),
    modes: {
      weekdays: { stops: weekdays },
      weekend: { stops: weekend },
      all: { stops: combined },
    },
    stops: combined,
  };

  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/schedule.json", JSON.stringify(out, null, 2), "utf8");
  console.log(
    `Saved stops: weekdays=${Object.keys(weekdays).length}, weekend=${Object.keys(weekend).length}, all=${Object.keys(combined).length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
