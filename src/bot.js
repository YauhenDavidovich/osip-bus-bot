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

function formatStop(name) {
  const lines = db.stops[name] || [];
  if (!lines.length) return `Нет данных по остановке: ${name}`;
  return [`🚌 Остановка: ${name}`, `Обновлено: ${db.updatedAt}`, "", ...lines.slice(0, 80)].join("\n");
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
    await ctx.reply(out.length > 3900 ? out.slice(0, 3900) : out);
    return;
  }

  // fuzzy fallback
  const key = Object.keys(db.stops).find((k) => k.toLowerCase().includes(text.toLowerCase()));
  if (key) {
    const out = formatStop(key);
    await ctx.reply(out.length > 3900 ? out.slice(0, 3900) : out);
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
