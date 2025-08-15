// =================================================================
// Advanced Analytics Bot - v500 (Full-Featured & Stable Polling)
// =================================================================

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);

// --- State Variables ---
let waitingState = null;

// =================================================================
// SECTION 0: OKX API ADAPTER (No Changes)
// =================================================================
class OKXAdapter {
    constructor() { this.name = "OKX"; this.baseURL = "https://www.okx.com"; }
    getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }
    async getMarketPrices() { try { const tickersRes = await fetch(`${this.baseURL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { return { error: `فشل جلب أسعار السوق: ${tickersJson.msg}` }; } const prices = {}; tickersJson.data.forEach(t => { if (t.instId.endsWith('-USDT')) { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice; prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h), instId: t.instId }; } }); return prices; } catch (error) { return { error: "خطأ استثنائي عند جلب أسعار السوق." }; } }
    async getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` }; } let assets = [], total = 0, usdtValue = 0; json.data.details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const value = amount * priceData.price; total += value; if (asset.ccy === "USDT") usdtValue = value; if (value >= 1) assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h }); } }); assets.sort((a, b) => b.value - a.value); return { assets, total, usdtValue }; } catch (e) { return { error: "خطأ في الاتصال بمنصة OKX." }; } }
    async getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${this.baseURL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data) return { error: `لم يتم العثور على العملة.` }; const tickerData = tickerJson.data; return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), }; } catch (e) { return { error: "خطأ في الاتصال بالمنصة." }; } }
}
const okxAdapter = new OKXAdapter();

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS (No Changes)
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
async function getConfig(id, defaultValue = []) { try { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; } catch (e) { return defaultValue; } }
async function saveConfig(id, data) { try { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); } catch (e) { console.error(`Error in saveConfig for id: ${id}`, e); } }
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value || 0;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadHistory = async () => await getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = async () => await getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
function formatNumber(num, decimals = 2) { const number = parseFloat(num); if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); return number.toFixed(decimals); }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue }; }

// =================================================================
// SECTION 2: BOT LOGIC AND HANDLERS (Full-Featured Telegraf Version)
// =================================================================
bot.use((ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) return next(); console.log(`Unauthorized access: ${ctx.from?.id}`); });
const mainKeyboard = Markup.keyboard([['📊 عرض المحفظة', '📈 أداء المحفظة'], ['🚀 تحليل السوق', 'ℹ️ معلومات عملة']]).resize();
const performanceKeyboard = Markup.inlineKeyboard([Markup.button.callback('آخر 24 ساعة', 'chart_24h'), Markup.button.callback('آخر 7 أيام', 'chart_7d'), Markup.button.callback('آخر 30 يومًا', 'chart_30d')]);

bot.start((ctx) => ctx.replyWithMarkdown('🤖 *أهلاً بك في بوت التحليل المتكامل.*\n\nاختر أحد الخيارات من القائمة.', mainKeyboard));

bot.command("fixdb", async (ctx) => {
    await ctx.reply("🔧 **إعادة بناء قاعدة البيانات...**");
    try {
        const mockDailyHistory = Array.from({ length: 30 }, (_, i) => { const date = new Date(); date.setDate(date.getDate() - (29 - i)); return { date: date.toISOString().slice(0, 10), total: 5000 + Math.random() * 500 }; });
        const mockHourlyHistory = Array.from({ length: 72 }, (_, i) => { const date = new Date(); date.setHours(date.getHours() - (71 - i)); return { label: date.toISOString().slice(0, 13), total: 5000 + Math.random() * 500 }; });
        await saveHistory(mockDailyHistory);
        await saveHourlyHistory(mockHourlyHistory);
        await ctx.reply("✅ **تم الإصلاح بنجاح!**");
    } catch (error) { await ctx.reply(`❌ **فشل الإصلاح:** ${error.message}`); }
});

bot.hears('📊 عرض المحفظة', async (ctx) => {
    const loadingMsg = await ctx.reply("⏳ جاري إعداد التقرير...");
    try {
        const prices = await okxAdapter.getMarketPrices(); if (prices.error) throw new Error(prices.error);
        const portfolio = await okxAdapter.getPortfolio(prices); if (portfolio.error) throw new Error(portfolio.error);
        const { assets, total } = portfolio;
        let msg = `🧾 *التقرير التحليلي للمحفظة*\n*القيمة الإجمالية:* \`$${formatNumber(total)}\``;
        assets.forEach(a => { msg += `\n- *${a.asset}*: \`$${formatNumber(a.value)}\` (\`${formatNumber((a.value / total) * 100)}%\`)`; });
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: "Markdown" });
    } catch (e) { await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`); }
});

bot.hears('📈 أداء المحفظة', (ctx) => ctx.reply('اختر الفترة الزمنية:', performanceKeyboard));

bot.hears('🚀 تحليل السوق', async (ctx) => {
    const loadingMsg = await ctx.reply("⏳ جاري تحليل السوق...");
    try {
        const prices = await okxAdapter.getMarketPrices(); if (prices.error) throw new Error(prices.error);
        const marketData = Object.values(prices).filter(d => d.volCcy24h > 10000 && d.change24h !== undefined);
        marketData.sort((a, b) => b.change24h - a.change24h);
        const topGainers = marketData.slice(0, 5);
        const topLosers = marketData.slice(-5).reverse();
        let msg = `🚀 *تحليل السوق المتقدم (OKX)*\n\n` + `📈 *أكبر الرابحين (24س):*\n` + topGainers.map(c => ` - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n" + `📉 *أكبر الخاسرين (24س):*\n` + topLosers.map(c => ` - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\``).join('\n');
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: 'Markdown' });
    } catch (e) { await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`); }
});

bot.hears('ℹ️ معلومات عملة', (ctx) => {
    waitingState = 'coin_info';
    ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
});

bot.action(/chart_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const period = ctx.match[1];
    try {
        await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء...");
        const history = period === '24h' ? await loadHourlyHistory() : await loadHistory();
        const periodLabel = period === '24h' ? "آخر 24 ساعة" : (period === '7d' ? "آخر 7 أيام" : "آخر 30 يومًا");
        const relevantHistory = period === '24h' ? history.slice(-24) : (period === '7d' ? history.slice(-7) : history.slice(-30));
        if (relevantHistory.length < 2) return ctx.editMessageText(`ℹ️ لا توجد بيانات كافية لهذه الفترة.`);
        const stats = calculatePerformanceStats(relevantHistory);
        if (!stats) return ctx.editMessageText("ℹ️ فشل حساب الإحصائيات.");
        const pnlSign = stats.pnl >= 0 ? '+' : '';
        const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n` + `*النتيجة:* \`${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` + `*من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*`;
        await ctx.editMessageText(caption, { parse_mode: "Markdown" });
    } catch (error) { await ctx.editMessageText(`❌ حدث خطأ: ${error.message}`); }
});

bot.on('text', async (ctx) => {
    if (!waitingState) return;
    const state = waitingState;
    waitingState = null;
    if (state === 'coin_info') {
        const instId = ctx.message.text.toUpperCase();
        const loadingMsg = await ctx.reply(`⏳ جاري تجهيز التقرير لـ ${instId}...`);
        try {
            const details = await okxAdapter.getInstrumentDetails(instId);
            if(details.error) throw new Error(details.error);
            let msg = `ℹ️ *الملف التحليلي | ${instId}*\n\n` + `*السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n` + `*أعلى (24س):* \`$${formatNumber(details.high24h, 4)}\`\n` + `*أدنى (24س):* \`$${formatNumber(details.low24h, 4)}\`\n` + `*حجم التداول:* \`$${formatNumber(details.vol24h / 1e6, 2)}M\``;
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: "Markdown" });
        } catch (e) { await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`); }
    }
});

// =================================================================
// SECTION 3: SERVER AND BOT INITIALIZATION (Polling Version)
// =================================================================
async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");
        app.get("/healthcheck", (req, res) => res.status(200).send("OK"));
        app.listen(PORT, () => console.log(`Healthcheck server running on port ${PORT}`));
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        bot.launch({ dropPendingUpdates: true });
        console.log("Bot is now fully operational using Polling.");
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (e) { console.error("FATAL: Could not start the bot.", e); process.exit(1); }
}

startBot();
