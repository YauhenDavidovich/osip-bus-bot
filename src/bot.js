import "dotenv/config";
import fs from "fs/promises";
import pdfParse from "pdf-parse";
import { Telegraf, Markup } from "telegraf";

const SUBURBAN_SOURCES = [
  "https://osipovichi.com/auto_pr.html",
  "https://osipinfo.by/prigorodnye-avtobusy.html",
  "https://www.osipovichi.gov.by/uploads/files/Raspisanie-prigorod.pdf",
];

const TRAINS_URL = "https://rasp.yandex.by/station/9614258/suburban/";
const DIESEL_URL = "https://poezdato.net/raspisanie-po-stancyi/osipovichi/";
const LONG_TRAINS_URL = "https://poezdato.net/raspisanie-po-stancyi/osipovichi/";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);

let db = { sources: {}, updatedAt: "", modes: { weekdays: { stops: {} }, weekend: { stops: {} }, all: { stops: {} } }, stops: {} };
const modeByChat = new Map();
const liveCache = {
  suburban: { ts: 0, text: "" },
  diesel: { ts: 0, text: "" },
  long: { ts: 0, text: "" },
  trains: { ts: 0, text: "" },
};
const CACHE_TTL_MS = 10 * 60 * 1000;

function getMode(chatId) {
  return modeByChat.get(chatId) || "weekdays";
}

function getStopsForMode(mode) {
  return db?.modes?.[mode]?.stops || db.stops || {};
}

async function loadDb() {
  const raw = await fs.readFile("data/schedule.json", "utf8");
  db = JSON.parse(raw);
}

function stopKeyboard(mode = "weekdays") {
  const names = Object.keys(getStopsForMode(mode)).sort();
  const rows = [];
  rows.push(["🏙 Город", "🚌 Пригород"]);
  rows.push(["🚆 Электрички", "🚉 Дизеля", "🚄 Дальние"]);
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2));
  rows.push(["📅 Будни", "📅 Выходные"]);
  rows.push(["🔄 Обновить данные", "ℹ️ Источник"]);
  return Markup.keyboard(rows).resize();
}

function expandRouteLine(line) {
  const fixed = String(line || "")
    .replace(/Г\s+имназия/g, "Гимназия")
    .replace(/\s{2,}/g, " ")
    .trim();

  const parts = fixed
    .split(/(?=(?:^|[.;])\s*\d{1,2}[А-ЯA-Z]?\s*[—-]\s*[А-ЯA-Zа-я])/g)
    .map((s) => s.replace(/^[.;\s]+/, "").trim())
    .filter(Boolean);

  return parts.length ? parts : [fixed];
}

function prettifyLine(s) {
  return String(s || "")
    .replace(/\b(\d)\s+(\d)\s*([—-])/g, "$1$2 $3")
    .replace(/:0\s+/g, ":0")
    .replace(/;\s*0\s+/g, "; 0")
    .replace(/\b0\s+(\d:[0-5]\d)\b/g, "0$1")
    .replace(/(\d)\s*:\s*(\d)\s+(\d)/g, "$1:$2$3")
    .replace(/(^|\D)(\d)\s+(\d:\d{2})/g, "$10$2$3")
    .replace(/(^|\D)(\d{1,2}:\d)\s+(\d)(\D|$)/g, "$1$2$3$4")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatStop(name, mode = "weekdays") {
  const current = getStopsForMode(mode);
  const lines = current[name] || [];
  const modeLabel = mode === "weekend" ? "выходные" : "будни";

  if (!lines.length) {
    const altMode = mode === "weekend" ? "weekdays" : "weekend";
    const altLines = getStopsForMode(altMode)[name] || [];
    if (altLines.length) {
      return `Нет данных по остановке: ${name} (${modeLabel}).\nНо есть данные для режима: ${altMode === "weekend" ? "выходные" : "будни"}. Переключи режим кнопкой 📅.`;
    }
    return `Нет данных по остановке: ${name}`;
  }

  const expanded = lines.flatMap(expandRouteLine).map(prettifyLine).filter((s) => s.length > 8);
  const pretty = expanded.map((l) => `• ${l}`);

  return [
    `🚌 Остановка: ${name}`,
    `Режим: ${modeLabel}`,
    `Обновлено: ${db.updatedAt}`,
    `Маршрутов/записей: ${pretty.length}`,
    "",
    ...pretty,
  ].join("\n");
}

async function replyChunked(ctx, text, max = 3800) {
  if (text.length <= max) {
    await ctx.reply(text);
    return;
  }
  for (let i = 0; i < text.length; i += max) {
    await ctx.reply(text.slice(i, i + max));
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parsePoezdatoRows(text) {
  const re = /(\d{3,4}[A-ЯA-Z\/]*?)\s+([A-ЯЁа-яё(). -]{2,40}?)\s*→\s*([A-ЯЁа-яё(). -]{2,40}?)\s+(\d{2}\.\d{2})(?:\s+\d+\s*мин)?\s+(\d{2}\.\d{2})/g;
  const rows = [];
  for (const m of text.matchAll(re)) {
    const num = m[1].trim();
    const from = m[2].trim();
    const to = m[3].trim();
    const depart = m[5].replace('.', ':');
    rows.push({ num, from, to, depart });
    if (rows.length > 300) break;
  }
  return rows;
}

async function fetchTrainPreview() {
  try {
    if (Date.now() - liveCache.trains.ts < CACHE_TTL_MS && liveCache.trains.text) return liveCache.trains.text;

    const res = await fetch(TRAINS_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const text = htmlToText(html);
    const re = /(\d{2}:\d{2})\s+Осиповичи-1\s+[—-]\s+([^\d]{3,40}?)\s+(\d{4})/g;
    const rows = [];
    for (const m of text.matchAll(re)) {
      rows.push(`• ${m[1]} → ${m[2].trim()} (#${m[3]})`);
      if (rows.length >= 8) break;
    }

    const out = rows.length ? rows.join("\n") : "Не удалось распарсить ближайшие электрички. Открой источник ниже.";
    liveCache.trains = { ts: Date.now(), text: out };
    return out;
  } catch {
    return "Не удалось получить онлайн-данные по электричкам прямо сейчас.";
  }
}

async function fetchSuburbanBusPreview() {
  try {
    if (Date.now() - liveCache.suburban.ts < CACHE_TTL_MS && liveCache.suburban.text) return liveCache.suburban.text;

    const res = await fetch(SUBURBAN_SOURCES[2], { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const pdf = await pdfParse(buf);
    const text = String(pdf.text || "").replace(/\s{2,}/g, " ");

    const re = /(\d{2,3}(?:-[A-ЯA-Z])?)\s+([A-ЯЁа-яё(). -]{3,60}?-[A-ЯЁа-яё(). -]{2,60}?)\s+((?:\d{1,2}[\-:]\d{2}(?:,\s*)?){1,8})/g;
    const rows = [];
    for (const m of text.matchAll(re)) {
      const route = m[1].trim();
      const dir = m[2].replace(/\s{2,}/g, ' ').trim();
      const times = m[3].replace(/-/g, ':').replace(/\s+/g, ' ').trim();
      rows.push(`• ${route} ${dir} — ${times}`);
      if (rows.length >= 12) break;
    }

    const out = rows.length
      ? rows.join("\n")
      : "Не удалось уверенно распарсить пригород из PDF. Используй кнопки источников ниже.";
    liveCache.suburban = { ts: Date.now(), text: out };
    return out;
  } catch {
    return "Не удалось получить/распарсить пригородные автобусы онлайн.";
  }
}

async function fetchRailByType(type, directionQuery = "") {
  try {
    const key = type === "long" ? "long" : "diesel";
    const q = directionQuery.trim().toLowerCase();

    const useCache = !q && Date.now() - liveCache[key].ts < CACHE_TTL_MS && liveCache[key].text;
    if (useCache) return liveCache[key].text;

    const res = await fetch(DIESEL_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    const all = parsePoezdatoRows(text);

    let filtered = all.filter((r) => {
      const n = r.num;
      const isSuburban = /^\d{4}$/.test(n);
      const isLong = !isSuburban;
      return type === "diesel" ? isSuburban : isLong;
    });

    if (q) {
      filtered = filtered.filter((r) => `${r.from} ${r.to}`.toLowerCase().includes(q));
    }

    const rows = filtered.slice(0, 12).map((r) => `• ${r.depart} ${r.from} → ${r.to} (#${r.num})`);
    const out = rows.length
      ? rows.join("\n")
      : q
        ? `Ничего не найдено по направлению: ${directionQuery}`
        : "Не удалось получить данные по выбранной категории.";

    if (!q) liveCache[key] = { ts: Date.now(), text: out };
    return out;
  } catch {
    return "Не удалось получить данные по железной дороге прямо сейчас.";
  }
}

function suburbanLinksKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url("osipinfo (пригород)", SUBURBAN_SOURCES[1])],
    [Markup.button.url("osipovichi.com (пригород)", SUBURBAN_SOURCES[0])],
    [Markup.button.url("Осиповичский райисполком PDF", SUBURBAN_SOURCES[2])],
  ]);
}

function railLinksKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.url("Электрички (Яндекс)", TRAINS_URL)],
    [Markup.button.url("Дизеля/пригородные поезда", DIESEL_URL)],
    [Markup.button.url("Поезда дальнего следования", LONG_TRAINS_URL)],
  ]);
}

bot.start(async (ctx) => {
  const chatId = ctx.chat?.id;
  if (chatId) modeByChat.set(chatId, "weekdays");
  await ctx.reply(
    "Осиповичи: навигатор по автобусам. Выбери режим (будни/выходные) и остановку.",
    stopKeyboard("weekdays")
  );
});

bot.command("stops", async (ctx) => {
  const mode = getMode(ctx.chat?.id);
  await ctx.reply(`Список остановок (${mode === "weekend" ? "выходные" : "будни"}) 👇`, stopKeyboard(mode));
});

bot.command("find", async (ctx) => {
  const q = (ctx.message.text || "").split(" ").slice(1).join(" ").trim().toLowerCase();
  if (!q) {
    await ctx.reply("Используй: /find <часть названия остановки>");
    return;
  }

  const mode = getMode(ctx.chat?.id);
  const names = Object.keys(getStopsForMode(mode));
  const matched = names.filter((n) => n.toLowerCase().includes(q));
  if (!matched.length) {
    const inAll = Object.keys(getStopsForMode("all")).filter((n) => n.toLowerCase().includes(q));
    if (inAll.length) {
      await ctx.reply(
        `В текущем режиме не найдено. Но есть в другом режиме:\n${inAll.map((s) => `• ${s}`).join("\n")}\n\nПереключи режим кнопкой 📅.`
      );
      return;
    }

    await ctx.reply("Не нашёл остановку. Попробуй другое слово.");
    return;
  }

  await ctx.reply("Найдено:\n" + matched.map((s) => `• ${s}`).join("\n"));
});

bot.command("suburban", async (ctx) => {
  const preview = await fetchSuburbanBusPreview();
  await ctx.reply(
    [
      "🚌 Пригородные автобусы (превью):",
      preview,
      "",
      "Если нет нужного направления — открой источники кнопками ниже.",
    ].join("\n"),
    suburbanLinksKeyboard()
  );
});

bot.command("trains", async (ctx) => {
  const preview = await fetchTrainPreview();
  await ctx.reply(`🚆 Ближайшие электрички со станции Осиповичи-1:\n${preview}`, railLinksKeyboard());
});

bot.command("diesel", async (ctx) => {
  const q = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  const preview = await fetchRailByType("diesel", q);
  await ctx.reply(`🚉 Дизеля/пригородные поезда${q ? ` (${q})` : ""}:\n${preview}`, railLinksKeyboard());
});

bot.command("long", async (ctx) => {
  const q = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  const preview = await fetchRailByType("long", q);
  await ctx.reply(`🚄 Поезда дальнего следования${q ? ` (${q})` : ""}:\n${preview}`, railLinksKeyboard());
});

bot.command("rail", async (ctx) => {
  const q = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  const diesel = await fetchRailByType("diesel", q);
  const long = await fetchRailByType("long", q);
  await replyChunked(
    ctx,
    [
      `🚉 Дизеля${q ? ` (${q})` : ""}:`,
      diesel,
      "",
      `🚄 Дальние${q ? ` (${q})` : ""}:`,
      long,
    ].join("\n")
  );
});

bot.hears("🏙 Город", async (ctx) => {
  const mode = getMode(ctx.chat?.id);
  await ctx.reply(`Режим города: ${mode === "weekend" ? "выходные" : "будни"}. Выбирай остановку 👇`, stopKeyboard(mode));
});

bot.hears("🚌 Пригород", async (ctx) => {
  const preview = await fetchSuburbanBusPreview();
  await ctx.reply(
    [
      "🚌 Пригородные автобусы (превью):",
      preview,
      "",
      "Источники ниже 👇",
    ].join("\n"),
    suburbanLinksKeyboard()
  );
});

bot.hears("🚆 Электрички", async (ctx) => {
  const preview = await fetchTrainPreview();
  await ctx.reply(`🚆 Ближайшие электрички со станции Осиповичи-1:\n${preview}`, railLinksKeyboard());
});

bot.hears("🚉 Дизеля", async (ctx) => {
  const preview = await fetchRailByType("diesel");
  await ctx.reply(`🚉 Дизеля/пригородные поезда (превью):\n${preview}`, railLinksKeyboard());
});

bot.hears("🚄 Дальние", async (ctx) => {
  const preview = await fetchRailByType("long");
  await ctx.reply(`🚄 Поезда дальнего следования (превью):\n${preview}`, railLinksKeyboard());
});

bot.hears("📅 Будни", async (ctx) => {
  if (ctx.chat?.id) modeByChat.set(ctx.chat.id, "weekdays");
  await ctx.reply("Режим: будни ✅", stopKeyboard("weekdays"));
});

bot.hears("📅 Выходные", async (ctx) => {
  if (ctx.chat?.id) modeByChat.set(ctx.chat.id, "weekend");
  await ctx.reply("Режим: выходные ✅", stopKeyboard("weekend"));
});

bot.hears("🔄 Обновить данные", async (ctx) => {
  await loadDb();
  const mode = getMode(ctx.chat?.id);
  await ctx.reply("Данные перечитаны из data/schedule.json ✅", stopKeyboard(mode));
});

bot.hears("ℹ️ Источник", async (ctx) => {
  await ctx.reply(
    `Источники:\n• Будни: ${db.sources?.weekdays || "-"}\n• Выходные: ${db.sources?.weekend || "-"}\nОбновлено: ${db.updatedAt}`
  );
});

bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  if (!text || text.startsWith("/")) return;

  const mode = getMode(ctx.chat?.id);
  const stops = getStopsForMode(mode);

  if (stops[text]) {
    const out = formatStop(text, mode);
    await replyChunked(ctx, out);
    return;
  }

  // fuzzy fallback
  const key = Object.keys(stops).find((k) => k.toLowerCase().includes(text.toLowerCase()));
  if (key) {
    const out = formatStop(key, mode);
    await replyChunked(ctx, out);
  }
});

await loadDb();
await bot.telegram.setMyCommands([
  { command: "start", description: "Старт и меню" },
  { command: "stops", description: "Показать остановки" },
  { command: "find", description: "Поиск остановки" },
  { command: "suburban", description: "Пригородные автобусы" },
  { command: "trains", description: "Электрички" },
  { command: "diesel", description: "Дизеля" },
  { command: "long", description: "Дальние поезда" },
  { command: "rail", description: "ЖД (дизеля + дальние)" }
]);

bot.launch();
console.log("osip-bus-bot started");
