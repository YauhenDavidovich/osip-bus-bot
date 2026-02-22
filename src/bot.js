import "dotenv/config";
import fs from "fs/promises";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);

let db = { sources: {}, updatedAt: "", modes: { weekdays: { stops: {} }, weekend: { stops: {} }, all: { stops: {} } }, stops: {} };
const modeByChat = new Map();

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
    .split(/(?=\s\d{1,2}[А-ЯA-Z]?\s*[—-])/g)
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.length ? parts : [fixed];
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

  const expanded = lines.flatMap(expandRouteLine).filter((s) => s.length > 8);
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
  { command: "find", description: "Поиск остановки" }
]);

bot.launch();
console.log("osip-bus-bot started");
