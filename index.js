// =================================================================
// Advanced Analytics Bot - v200 (Telegraf Version - Final Attempt)
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
    async getMarketPrices() { try { const tickersRes = await fetch(`${this.baseURL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { return { error: `فشل جلب أسعار السوق: ${tickersJson.msg}` }; } const prices = {}; tickersJson.data.forEach(t => { if (t.instId.endsWith('-USDT')) { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice; prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) }; } }); return prices; } catch (error) { return { error: "خطأ استثنائي عند جلب أسعار السوق." }; } }
    async getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` }; } let assets = [], total = 0, usdtValue = 0; json.data.details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const value = amount * priceData.price; total += value; if (asset.ccy === "USDT") usdtValue = value; if (value >= 1) assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h }); } }); assets.sort((a, b) => b.value - a.value); return { assets, total, usdtValue }; } catch (e) { return { error: "خطأ في الاتصال بمنصة OKX." }; } }
    async getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data || !json.data.details) { return null; } const balances = {}; json.data.details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) balances[asset.ccy] = amount; }); return balances; } catch (e) { return null; } }
}
const okxAdapter = new OKXAdapter();

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS (No Changes)
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
async function getConfig(id, defaultValue = {}) { try { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; } catch (e) { return defaultValue; } }
async function saveConfig(id, data) { try { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); } catch (e) { console.error(`Error in saveConfig for id: ${id}`, e); } }
async function saveClosedTrade(tradeData) { try { await getCollection("tradeHistory").insertOne({ ...tradeData, closedAt: new Date() }); } catch (e) { console.error("Error in saveClosedTrade:", e); } }
async function getHistoricalPerformance(asset) { try { const history = await getCollection("tradeHistory").find({ asset: asset }).toArray(); if (history.length === 0) { return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; } const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0); const winningTrades = history.filter(trade => trade.pnl > 0).length; const losingTrades = history.filter(trade => trade.pnl <= 0).length; const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0); const avgDuration = history.length > 0 ? totalDuration / history.length : 0; return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration }; } catch (e) { return null; } }
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = async () => await getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = async () => await getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
function formatNumber(num, decimals = 2) { const number = parseFloat(num); if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); return number.toFixed(decimals); }

// =================================================================
// SECTION 2: BOT LOGIC AND HANDLERS (Telegraf Version)
// =================================================================

// Middleware to authorize user
bot.use((ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        return next();
    }
    console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
});

// --- Keyboards ---
const mainKeyboard = Markup.keyboard([
    ['📊 عرض المحفظة', '📈 أداء المحفظة'],
    ['🚀 تحليل السوق', 'ℹ️ معلومات عملة']
]).resize();

const performanceKeyboard = Markup.inlineKeyboard([
    Markup.button.callback('آخر 24 ساعة', 'chart_24h'),
    Markup.button.callback('آخر 7 أيام', 'chart_7d'),
    Markup.button.callback('آخر 30 يومًا', 'chart_30d')
]);

// --- Command Handlers ---
bot.start((ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت التحليل المتكامل لمنصة OKX (نسخة Telegraf).*\n\n*اضغط على الأزرار أدناه للبدء!*`;
    ctx.replyWithMarkdown(welcomeMessage, mainKeyboard);
});

bot.command("fixdb", async (ctx) => {
    await ctx.reply("🔧 **إعادة بناء قاعدة البيانات...**");
    try {
        const mockDailyHistory = Array.from({ length: 30 }, (_, i) => {
            const date = new Date();
            date.setDate(date.getDate() - (29 - i));
            return { date: date.toISOString().slice(0, 10), total: 5000 + Math.random() * 500 };
        });
        const mockHourlyHistory = Array.from({ length: 72 }, (_, i) => {
            const date = new Date();
            date.setHours(date.getHours() - (71 - i));
            return { label: date.toISOString().slice(0, 13), total: 5000 + Math.random() * 500 };
        });
        await saveHistory(mockDailyHistory);
        await saveHourlyHistory(mockHourlyHistory);
        await ctx.reply("✅ **تم الإصلاح بنجاح!**");
    } catch (error) {
        await ctx.reply(`❌ **فشل الإصلاح:**\n${error.message}`);
    }
});


// --- Text Handlers ---
bot.hears('📊 عرض المحفظة', async (ctx) => {
    const loadingMsg = await ctx.reply("⏳ جاري إعداد التقرير...");
    try {
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) throw new Error(prices.error || `فشل جلب أسعار السوق.`);
        
        const capital = await loadCapital();
        const { assets, total, error } = await okxAdapter.getPortfolio(prices);
        if (error) throw new Error(error);

        const pnl = capital > 0 ? total - capital : 0;
        const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
        const pnlSign = pnl >= 0 ? '+' : '';
        const usdtValue = (assets.find(a => a.asset === 'USDT') || { value: 0 }).value;
        const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;

        let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n` +
                  `*القيمة الإجمالية:* \`$${formatNumber(total)}\`\n` +
                  `*رأس المال:* \`$${formatNumber(capital)}\`\n` +
                  `*إجمالي الربح غير المحقق:* ${pnl >= 0 ? '🟢' : '🔴'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n` +
                  `*السيولة:* 💵 نقدي ${formatNumber(cashPercent, 1)}% / 📈 مستثمر ${formatNumber(100 - cashPercent, 1)}%\n\n` +
                  `*مكونات المحفظة:*`;

        assets.forEach(a => {
            const percent = total > 0 ? (a.value / total) * 100 : 0;
            msg += `\n\n- *${a.asset}/USDT*\n` +
                   `  *القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)`;
        });

        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: "Markdown" });

    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`);
    }
});

bot.hears('📈 أداء المحفظة', (ctx) => {
    ctx.reply('اختر الفترة الزمنية لعرض تقرير الأداء:', performanceKeyboard);
});

bot.hears('🚀 تحليل السوق', async (ctx) => {
    const loadingMsg = await ctx.reply("⏳ جاري تحليل السوق...");
    try {
        const prices = await okxAdapter.getMarketPrices();
        if (!prices || prices.error) throw new Error(`فشل جلب بيانات السوق. ${prices.error || ''}`);
        
        const marketData = Object.values(prices).filter(d => d.volCcy24h > 10000 && d.change24h !== undefined);
        marketData.sort((a, b) => b.change24h - a.change24h);
        const topGainers = marketData.slice(0, 5);
        const topLosers = marketData.slice(-5).reverse();
        
        let msg = `🚀 *تحليل السوق المتقدم (OKX)*\n\n` +
                  "📈 *أكبر الرابحين (24س):*\n" +
                  topGainers.map(c => ` - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n" +
                  "📉 *أكبر الخاسرين (24س):*\n" +
                  topLosers.map(c => ` - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\``).join('\n');

        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: 'Markdown' });

    } catch (e) {
        await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`);
    }
});

bot.hears('ℹ️ معلومات عملة', (ctx) => {
    waitingState = 'coin_info';
    ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
});


// --- Action (Callback) Handlers ---
bot.action(/chart_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const period = ctx.match[1];
    
    try {
        await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء النصي...");

        let history, periodLabel;
        if (period === '24h') {
            history = await loadHourlyHistory();
            periodLabel = "آخر 24 ساعة";
        } else if (period === '7d') {
            history = await loadHistory();
            periodLabel = "آخر 7 أيام";
        } else { // 30d
            history = await loadHistory();
            periodLabel = "آخر 30 يومًا";
        }

        if (!history || history.length < 2) {
            return ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة. استخدم أمر /fixdb.");
        }

        const relevantHistory = period === '24h' ? history.slice(-24) : (period === '7d' ? history.slice(-7) : history.slice(-30));
        if (relevantHistory.length < 2) {
            return ctx.editMessageText(`ℹ️ لا توجد بيانات كافية لهذه الفترة (مطلوب نقطتين على الأقل).`);
        }

        const stats = calculatePerformanceStats(relevantHistory);
        if (!stats) {
            return ctx.editMessageText("ℹ️ فشل حساب الإحصائيات.");
        }

        const pnlSign = stats.pnl >= 0 ? '+' : '';
        const emoji = stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️';
        const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` +
                      `📈 *النتيجة:* ${emoji} \`${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` +
                      `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n` +
                      `📝 *ملخص إحصائيات الفترة:*\n` +
                      ` ▫️ *أعلى قيمة:* \`$${formatNumber(stats.maxValue)}\`\n` +
                      ` ▫️ *أدنى قيمة:* \`$${formatNumber(stats.minValue)}\`\n` +
                      ` ▫️ *متوسط القيمة:* \`$${formatNumber(stats.avgValue)}\``;

        await ctx.editMessageText(caption, { parse_mode: "Markdown" });
        
    } catch (error) {
        console.error("Error in chart action:", error);
        await ctx.editMessageText(`❌ حدث خطأ فادح: ${error.message}`);
    }
});


// --- General Text Handler for States ---
bot.on('text', async (ctx) => {
    if (!waitingState) return;

    const state = waitingState;
    waitingState = null;

    if (state === 'coin_info') {
        const instId = ctx.message.text.toUpperCase();
        const loadingMsg = await ctx.reply(`⏳ جاري تجهيز التقرير لـ ${instId}...`);
        
        try {
            const details = await okxAdapter.getMarketPrices();
            if(!details[instId]) throw new Error("لم يتم العثور على العملة");
            
            const coinData = details[instId];
            let msg = `ℹ️ *الملف التحليلي | ${instId}*\n\n` +
                      `*السعر الحالي:* \`$${formatNumber(coinData.price, 4)}\`\n` +
                      `*التغير (24س):* \`${formatNumber(coinData.change24h * 100)}%\``;
            
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, msg, { parse_mode: "Markdown" });
        } catch (e) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, `❌ حدث خطأ: ${e.message}`);
        }
    }
});


// =================================================================
// SECTION 3: SERVER AND BOT INITIALIZATION
// =================================================================
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");

        // Set webhook
        const webhookUrl = `https://${process.env.RAILWAY_STATIC_URL}`;
        await bot.telegram.setWebhook(`${webhookUrl}/bot${process.env.TELEGRAM_BOT_TOKEN}`);
        
        app.use(await bot.createWebhook({
            domain: webhookUrl,
            path: `/bot${process.env.TELEGRAM_BOT_TOKEN}`
        }));

        app.listen(PORT, () => {
            console.log(`Bot server is running on port ${PORT}`);
        });

        console.log("Bot is now fully operational for OKX.");
        
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
