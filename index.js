// =================================================================
// Advanced Analytics Bot - v134.1 (Telegraf Polling Version - Full Feature)
// =================================================================

const express = require("express");
const { Telegraf, Markup } = require('telegraf');
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
// SECTION 0: OKX API ADAPTER (From Your Code)
// =================================================================
class OKXAdapter {
    constructor() { this.name = "OKX"; this.baseURL = "https://www.okx.com"; }
    getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }
    async getMarketPrices() { try { const tickersRes = await fetch(`${this.baseURL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { return { error: `فشل جلب أسعار السوق: ${tickersJson.msg}` }; } const prices = {}; tickersJson.data.forEach(t => { if (t.instId.endsWith('-USDT')) { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice; prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) }; } }); return prices; } catch (error) { return { error: "خطأ استثنائي عند جلب أسعار السوق." }; } }
    async getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` }; } let assets = [], total = 0, usdtValue = 0; json.data.details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const value = amount * priceData.price; total += value; if (asset.ccy === "USDT") usdtValue = value; if (value >= 1) assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h }); } }); assets.sort((a, b) => b.value - a.value); return { assets, total, usdtValue }; } catch (e) { return { error: "خطأ في الاتصال بمنصة OKX." }; } }
}
const okxAdapter = new OKXAdapter();

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS (From Your Code)
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
async function getConfig(id, defaultValue = {}) { try { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; } catch (e) { return defaultValue; } }
async function saveConfig(id, data) { try { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); } catch (e) { console.error(`Error in saveConfig for id: ${id}`, e); } }
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false, dailyReportTime: "22:00" });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = async () => await getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = async () => await getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
function formatNumber(num, decimals = 2) { const number = parseFloat(num); if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); return number.toFixed(decimals); }

// =================================================================
// SECTION 2: DATA PROCESSING FUNCTIONS (From Your Code)
// =================================================================
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${okxAdapter.baseURL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data[0]) { return { error: `لم يتم العثور على العملة.` }; } const tickerData = tickerJson.data; return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), }; } catch (e) { throw new Error("خطأ في الاتصال بالمنصة لجلب بيانات السوق."); } }
async function getHistoricalCandles(instId, bar = '1D', limit = 100) { try { const url = `${okxAdapter.baseURL}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${limit}`; const res = await fetch(url); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) return []; return json.data.map(c => ({ time: parseInt(c), close: parseFloat(c[2]) })).reverse(); } catch (e) { console.error(`Error fetching historical candles for ${instId}:`, e); return []; } }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const dailyReturns = []; for (let i = 1; i < values.length; i++) { dailyReturns.push((values[i] - values[i - 1]) / values[i - 1]); } const bestDayChange = Math.max(...dailyReturns) * 100; const worstDayChange = Math.min(...dailyReturns) * 100; return { startValue, endValue, pnl, pnlPercent, bestDayChange, worstDayChange }; }
function createChartUrl(data, title, labels, dataLabel) { if (!data || data.length === 0) return null; const pnl = data[data.length - 1] - data; const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: dataLabel, data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }] }, options: { title: { display: true, text: title } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }


// =================================================================
// SECTION 3: FORMATTING AND MESSAGE FUNCTIONS (From Your Code)
// =================================================================
async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n*القيمة الإجمالية:* \`$${formatNumber(total)}\`\n*رأس المال:* \`$${formatNumber(capital)}\`\n*إجمالي الربح/الخسارة:* \`${pnl >= 0 ? '+' : ''}${formatNumber(pnl)}\` (\`${pnl >= 0 ? '+' : ''}${formatNumber(pnlPercent)}%\`)\n`;
    assets.forEach(a => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        msg += `\n- *${a.asset}*:\n  *القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`;
        const position = positions[a.asset];
        if (position?.avgBuyPrice) {
            msg += `  *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`;
        }
    });
    return msg;
}

async function formatPerformanceReport(periodLabel, history, btcHistory) {
    const stats = calculatePerformanceStats(history);
    if (!stats) return { error: "ℹ️ لا توجد بيانات كافية لهذه الفترة." };
    let btcPerformanceText = " `لا تتوفر بيانات`";
    if (btcHistory && btcHistory.length >= 2) {
        const btcStart = btcHistory[0].close;
        const btcEnd = btcHistory[btcHistory.length - 1].close;
        const btcChange = (btcEnd - btcStart) / btcStart * 100;
        btcPerformanceText = `\`${btcChange >= 0 ? '+' : ''}${formatNumber(btcChange)}%\``;
    }
    const chartLabels = history.map(h => new Date(h.time).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }));
    const chartDataPoints = history.map(h => h.total);
    const chartUrl = createChartUrl(chartDataPoints, `أداء المحفظة - ${periodLabel}`, chartLabels, 'قيمة المحفظة ($)');
    const pnlSign = stats.pnl >= 0 ? '+' : '';
    let caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` +
        `📈 *النتيجة:* \`$${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` +
        `*مقارنة مع BTC:* ${btcPerformanceText}\n\n` +
        `▪️ *أفضل يوم:* \`+${formatNumber(stats.bestDayChange)}%\`\n` +
        `▪️ *أسوأ يوم:* \`${formatNumber(stats.worstDayChange)}%\``;
    return { caption, chartUrl };
}

// =================================================================
// SECTION 5: BOT SETUP, KEYBOARDS, AND HANDLERS (Telegraf Version)
// =================================================================
const mainKeyboard = Markup.keyboard([
    ['📊 عرض المحفظة', '📈 أداء المحفظة'],
    ['🚀 تحليل السوق', '💡 توصية افتراضية'],
    ['⚡ إحصائيات سريعة', '📈 تحليل تراكمي'],
    ['🔔 ضبط تنبيه', 'ℹ️ معلومات عملة'],
    ['🧮 حاسبة الربح والخسارة', '⚙️ الإعدادات']
]).resize();

const virtualTradeKeyboard = Markup.inlineKeyboard([
    Markup.button.callback('➕ إضافة توصية جديدة', 'add_virtual_trade'),
    Markup.button.callback('📈 متابعة التوصيات الحية', 'track_virtual_trades')
]);

const performanceKeyboard = Markup.inlineKeyboard([
    Markup.button.callback("آخر 24 ساعة", "chart_24h"),
    Markup.button.callback("آخر 7 أيام", "chart_7d"),
    Markup.button.callback("آخر 30 يومًا", "chart_30d")
]);

// --- Middleware ---
bot.use((ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        return next();
    }
    console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
});

// --- Commands ---
bot.start((ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت التحليل المتكامل لمنصة OKX.*\n\n*اضغط على الأزرار أدناه للبدء!*`;
    ctx.replyWithMarkdown(welcomeMessage, mainKeyboard);
});

bot.command("pnl", async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 3) {
        return ctx.replyWithMarkdown(`❌ *صيغة غير صحيحة.*\n*مثال:* \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``);
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if ([buyPrice, sellPrice, quantity].some(isNaN) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة.");
    }
    const pnl = (sellPrice - buyPrice) * quantity;
    const pnlPercent = (pnl / (buyPrice * quantity)) * 100;
    const msg = `🧮 *نتيجة حساب الربح والخسارة*\n\n` +
        `*صافي الربح/الخسارة:* \`${pnl >= 0 ? '+' : ''}${formatNumber(pnl)}\` (\`${pnl >= 0 ? '+' : ''}${formatNumber(pnlPercent)}%\`)`;
    await ctx.replyWithMarkdown(msg);
});

// --- Text Handlers ---
bot.hears('📊 عرض المحفظة', async (ctx) => {
    const loadingMsg = await ctx.reply("⏳ جاري إعداد التقرير...");
    try {
        const prices = await okxAdapter.getMarketPrices();
        if (prices.error) throw new Error(prices.error);
        const capital = await loadCapital();
        const { assets, total } = await okxAdapter.getPortfolio(prices);
        const msg = await formatPortfolioMsg(assets, total, capital);
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`);
    }
});

bot.hears('📈 أداء المحفظة', (ctx) => {
    ctx.reply("اختر الفترة الزمنية لعرض تقرير الأداء:", performanceKeyboard);
});

bot.hears('ℹ️ معلومات عملة', (ctx) => {
    waitingState = 'coin_info';
    ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
});

// --- Action Handlers ---
bot.action(/chart_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const period = ctx.match[1];
    await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء المتقدم...");
    try {
        let history, periodLabel, bar, limit;
        if (period === '24h') { history = await loadHourlyHistory(); periodLabel = "آخر 24 ساعة"; bar = '1H'; limit = 24; }
        else if (period === '7d') { history = await loadHistory(); periodLabel = "آخر 7 أيام"; bar = '1D'; limit = 7; }
        else { history = await loadHistory(); periodLabel = "آخر 30 يومًا"; bar = '1D'; limit = 30; }
        
        const portfolioHistory = (period === '24h' ? history.slice(-24) : history.slice(-limit)).map(h => ({ ...h, time: h.time || Date.parse(h.date || h.label)}));
        if (portfolioHistory.length < 2) return ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة.");
        
        const btcHistory = await getHistoricalCandles('BTC-USDT', bar, limit);
        const report = await formatPerformanceReport(periodLabel, portfolioHistory, btcHistory);

        if (report.error) {
            await ctx.editMessageText(report.error);
        } else {
            await ctx.replyWithPhoto(report.chartUrl, { caption: report.caption, parse_mode: "Markdown" });
            await ctx.deleteMessage();
        }
    } catch(e) {
        console.error("Chart action error:", e);
        await ctx.editMessageText(`❌ حدث خطأ أثناء إنشاء التقرير: ${e.message}`);
    }
});


// --- General Text Handler ---
bot.on('text', async (ctx) => {
    if (!waitingState) return;
    const state = waitingState;
    waitingState = null;
    if (state === 'coin_info') {
        const instId = ctx.message.text.toUpperCase();
        const loadingMsg = await ctx.reply(`⏳ جاري تجهيز التقرير لـ ${instId}...`);
        try {
            const details = await getInstrumentDetails(instId);
            if (details.error) throw new Error(details.error);
            let msg = `ℹ️ *الملف التحليلي الكامل | ${instId}*\n\n` +
                `*السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n` +
                `*أعلى (24س):* \`$${formatNumber(details.high24h, 4)}\`\n` +
                `*أدنى (24س):* \`$${formatNumber(details.low24h, 4)}\`\n` +
                `*حجم التداول:* \`$${formatNumber(details.vol24h / 1e6, 2)}M\``;
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: 'Markdown' });
        } catch (e) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`);
        }
    }
});


// =================================================================
// SECTION 6: SERVER AND BOT INITIALIZATION (Polling Version)
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
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
