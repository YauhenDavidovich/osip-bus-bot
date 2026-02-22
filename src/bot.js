import "dotenv/config";
import fs from "fs/promises";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Telegraf(BOT_TOKEN);

let db = { source: "", updatedAt: "", stops: {} };

async function loadDb() {
  const raw = await fs.readFile("data/schedule.json", "utf8");
  db = JSON.parse(raw);
}

function stopKeyboard() {
  const names = Object.keys(db.stops).sort();
  const rows = [];
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2));
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

function formatStop(name) {
  const lines = db.stops[name] || [];
  if (!lines.length) return `Нет данных по остановке: ${name}`;

  const expanded = lines.flatMap(expandRouteLine).filter((s) => s.length > 8);
  const pretty = expanded.map((l) => `• ${l}`);

  return [
    `🚌 Остановка: ${name}`,
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
  await ctx.reply(
    "Осиповичи: навигатор по автобусам (будние дни). Выбери остановку кнопкой ниже.",
    stopKeyboard()
  );
});

bot.command("stops", async (ctx) => {
  await ctx.reply("Список остановок ниже 👇", stopKeyboard());
});

bot.command("find", async (ctx) => {
  const q = (ctx.message.text || "").split(" ").slice(1).join(" ").trim().toLowerCase();
  if (!q) {
    await ctx.reply("Используй: /find <часть названия остановки>");
    return;
  }

  const names = Object.keys(db.stops);
  const matched = names.filter((n) => n.toLowerCase().includes(q));
  if (!matched.length) {
    await ctx.reply("Не нашёл остановку. Попробуй другое слово.");
    return;
  }

  await ctx.reply("Найдено:\n" + matched.map((s) => `• ${s}`).join("\n"));
});

bot.hears("🔄 Обновить данные", async (ctx) => {
  await loadDb();
  await ctx.reply("Данные перечитаны из data/schedule.json ✅", stopKeyboard());
});

bot.hears("ℹ️ Источник", async (ctx) => {
  await ctx.reply(`Источник: ${db.source}\nОбновлено: ${db.updatedAt}`);
});

bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  if (!text || text.startsWith("/")) return;

  if (db.stops[text]) {
    const out = formatStop(text);
    await replyChunked(ctx, out);
    return;
  }

  // fuzzy fallback
  const key = Object.keys(db.stops).find((k) => k.toLowerCase().includes(text.toLowerCase()));
  if (key) {
    const out = formatStop(key);
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
