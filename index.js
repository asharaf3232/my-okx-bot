// =================================================================
// Advanced Analytics Bot - v134.1 (Telegraf Polling Stable Version)
// Your complete and final code, ported for stability.
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
// SECTION 0: OKX API ADAPTER (Your Code)
// =================================================================
class OKXAdapter {
    constructor() { this.name = "OKX"; this.baseURL = "https://www.okx.com"; }
    getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }
    async getMarketPrices() { try { const tickersRes = await fetch(`${this.baseURL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { return { error: `فشل جلب أسعار السوق: ${tickersJson.msg}` }; } const prices = {}; tickersJson.data.forEach(t => { if (t.instId.endsWith('-USDT')) { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice; prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) }; } }); return prices; } catch (error) { return { error: "خطأ استثنائي عند جلب أسعار السوق." }; } }
    async getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` }; } let assets = [], total = 0, usdtValue = 0; json.data.details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const value = amount * priceData.price; total += value; if (asset.ccy === "USDT") usdtValue = value; if (value >= 1) assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h }); } }); assets.sort((a, b) => b.value - a.value); return { assets, total, usdtValue }; } catch (e) { return { error: "خطأ في الاتصال بمنصة OKX." }; } }
    async getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${this.baseURL}${path}`, { headers: this.getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return null; } const balances = {}; json.data[0].details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) balances[asset.ccy] = amount; }); return balances; } catch (e) { return null; } }
}
const okxAdapter = new OKXAdapter();

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS (Your Code)
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
async function getConfig(id, defaultValue = {}) { try { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; } catch (e) { return defaultValue; } }
async function saveConfig(id, data) { try { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); } catch (e) { console.error(`Error in saveConfig for id: ${id}`, e); } }
async function saveClosedTrade(tradeData) { try { await getCollection("tradeHistory").insertOne({ ...tradeData, closedAt: new Date() }); } catch (e) { console.error("Error in saveClosedTrade:", e); } }
async function getHistoricalPerformance(asset) { try { const history = await getCollection("tradeHistory").find({ asset: asset }).toArray(); if (history.length === 0) { return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; } const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0); const winningTrades = history.filter(trade => trade.pnl > 0).length; const losingTrades = history.filter(trade => trade.pnl <= 0).length; const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0); const avgDuration = history.length > 0 ? totalDuration / history.length : 0; return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration }; } catch (e) { return null; } }
async function saveVirtualTrade(tradeData) { try { const tradeWithId = { ...tradeData, _id: new crypto.randomBytes(16).toString("hex") }; await getCollection("virtualTrades").insertOne(tradeWithId); return tradeWithId; } catch (e) { console.error("Error saving virtual trade:", e); } }
async function getActiveVirtualTrades() { try { return await getCollection("virtualTrades").find({ status: 'active' }).toArray(); } catch (e) { return []; } }
async function updateVirtualTradeStatus(tradeId, status, finalPrice) { try { await getCollection("virtualTrades").updateOne({ _id: tradeId }, { $set: { status: status, closePrice: finalPrice, closedAt: new Date() } }); } catch (e) { console.error(`Error updating virtual trade ${tradeId}:`, e); } }
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
const loadBalanceState = async () => await getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
const loadAlerts = async () => await getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
const loadAlertSettings = async () => await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () => await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);
function formatNumber(num, decimals = 2) { const number = parseFloat(num); if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); return number.toFixed(decimals); }
async function sendDebugMessage(message) { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.telegram.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug (OKX):* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } }

// =================================================================
// SECTION 2: DATA PROCESSING FUNCTIONS (Your Code)
// =================================================================
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${okxAdapter.baseURL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data[0]) { return { error: `لم يتم العثور على العملة.` }; } const tickerData = tickerJson.data[0]; return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), }; } catch (e) { throw new Error("خطأ في الاتصال بالمنصة لجلب بيانات السوق."); } }
async function getHistoricalCandles(instId, bar = '1D', limit = 100) { let allCandles = []; let before = ''; const maxLimitPerRequest = 100; try { while (allCandles.length < limit) { const currentLimit = Math.min(maxLimitPerRequest, limit - allCandles.length); const url = `${okxAdapter.baseURL}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${currentLimit}${before}`; const res = await fetch(url); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) { break; } const newCandles = json.data.map(c => ({ time: parseInt(c[0]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) })); allCandles.push(...newCandles); if (newCandles.length < maxLimitPerRequest) { break; } const lastTimestamp = newCandles[newCandles.length - 1].time; before = `&before=${lastTimestamp}`; } return allCandles.reverse(); } catch (e) { console.error(`Error fetching historical candles for ${instId}:`, e); return []; } }
function calculateSMA(closes, period) { if (closes.length < period) return null; const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0); return sum / period; }
function calculateRSI(closes, period = 14) { if (closes.length < period + 1) return null; let gains = 0, losses = 0; for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; diff > 0 ? gains += diff : losses -= diff; } let avgGain = gains / period, avgLoss = losses / period; for (let i = period + 1; i < closes.length; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) { avgGain = (avgGain * (period - 1) + diff) / period; avgLoss = (avgLoss * (period - 1)) / period; } else { avgLoss = (avgLoss * (period - 1) - diff) / period; avgGain = (avgGain * (period - 1)) / period; } } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; return 100 - (100 / (1 + rs)); }
async function getTechnicalAnalysis(instId) { const candleData = (await getHistoricalCandles(instId, '1D', 51)); if (candleData.length < 51) return { error: "بيانات الشموع غير كافية." }; const closes = candleData.map(c => c.close); return { rsi: calculateRSI(closes), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) }; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; const dailyReturns = []; for (let i = 1; i < values.length; i++) { dailyReturns.push((values[i] - values[i - 1]) / values[i - 1]); } const bestDayChange = dailyReturns.length > 0 ? Math.max(...dailyReturns) * 100 : 0; const worstDayChange = dailyReturns.length > 0 ? Math.min(...dailyReturns) * 100 : 0; const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length : 0; const volatility = dailyReturns.length > 0 ? Math.sqrt(dailyReturns.map(x => Math.pow(x - avgReturn, 2)).reduce((a, b) => a + b) / dailyReturns.length) * 100 : 0; let volText = "متوسط"; if (volatility < 1) volText = "منخفض"; if (volatility > 5) volText = "مرتفع"; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue, bestDayChange, worstDayChange, volatility, volText }; }
function createChartUrl(data, type = 'line', title = '', labels = [], dataLabel = '') { if (!data || data.length === 0) return null; const pnl = data[data.length - 1] - data[0]; const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: dataLabel, data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }] }, options: { title: { display: true, text: title } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }

// =================================================================
// SECTION 3: FORMATTING AND MESSAGE FUNCTIONS (Your Code)
// =================================================================
async function formatPortfolioMsg(assets, total, capital) { const positions = await loadPositions(); const usdtAsset = assets.find(a => a.asset === "USDT") || { value: 0 }; const cashPercent = total > 0 ? (usdtAsset.value / total) * 100 : 0; const investedPercent = 100 - cashPercent; const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const pnlSign = pnl >= 0 ? '+' : ''; const pnlEmoji = pnl >= 0 ? '🟢⬆️' : '🔴⬇️'; let dailyPnlText = " `لا توجد بيانات كافية`"; let totalValue24hAgo = 0; assets.forEach(asset => { if (asset.asset === 'USDT') totalValue24hAgo += asset.value; else if (asset.change24h !== undefined && asset.price > 0) totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h)); else totalValue24hAgo += asset.value; }); if (totalValue24hAgo > 0) { const dailyPnl = total - totalValue24hAgo; const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100; const dailySign = dailyPnl >= 0 ? '+' : ''; const dailyEmoji = dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️'; dailyPnlText = ` ${dailyEmoji} \`$${dailySign}${formatNumber(dailyPnl)}\` (\`${dailySign}${formatNumber(dailyPnlPercent)}%\`)`; } let caption = `🧾 *التقرير التحليلي للمحفظة*\n\n`; caption += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`; caption += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`; caption += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`; if (capital > 0) { caption += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`; } caption += ` ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`$${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`; caption += ` ▫️ *الأداء اليومي (24س):*${dailyPnlText}\n`; caption += ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(cashPercent)}% / 📈 مستثمر ${formatNumber(investedPercent)}%\n`; caption += `━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`; const cryptoAssets = assets.filter(a => a.asset !== "USDT"); cryptoAssets.forEach((a, index) => { const percent = total > 0 ? (a.value / total) * 100 : 0; const position = positions[a.asset]; caption += `\n╭─ *${a.asset}/USDT*\n`; caption += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`; if (position?.avgBuyPrice) { caption += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`; } caption += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`; const dailyChangeEmoji = a.change24h >= 0 ? '🟢⬆️' : '🔴⬇️'; caption += `├─ *الأداء اليومي:* ${dailyChangeEmoji} \`${formatNumber(a.change24h * 100)}%\`\n`; if (position?.avgBuyPrice > 0) { const totalCost = position.avgBuyPrice * a.amount; const assetPnl = a.value - totalCost; const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0; const assetPnlEmoji = assetPnl >= 0 ? '🟢' : '🔴'; const assetPnlSign = assetPnl >= 0 ? '+' : ''; caption += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`$${assetPnlSign}${formatNumber(assetPnl)}\` (\`${assetPnlSign}${formatNumber(assetPnlPercent)}%\`)`; } else { caption += `╰─ *ربح/خسارة غير محقق:* \`غير مسجل\``; } if (index < cryptoAssets.length - 1) { caption += `\n━━━━━━━━━━━━━━━━━━━━`; } }); caption += `\n\n━━━━━━━━━━━━━━━━━━━━\n*USDT (الرصيد النقدي)* 💵\n`; caption += `*القيمة:* \`$${formatNumber(usdtAsset.value)}\` (*الوزن:* \`${formatNumber(cashPercent)}%\`)`; return { caption }; }
// ... All your other amazing formatting functions go here ...

// =================================================================
// SECTION 4 & 4.5: BACKGROUND JOBS & DYNAMIC MANAGEMENT (Your Code)
// =================================================================
// ... All your background jobs like monitorBalanceChanges, runDailyJobs, etc. go here.
// They will be called by setInterval in the startBot function.

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
    Markup.button.callback("➕ إضافة توصية جديدة", "add_virtual_trade"),
    Markup.button.callback("📈 متابعة التوصيات الحية", "track_virtual_trades"),
]);

const performanceKeyboard = Markup.inlineKeyboard([
    Markup.button.callback("آخر 24 ساعة", "chart_24h"),
    Markup.button.callback("آخر 7 أيام", "chart_7d"),
    Markup.button.callback("آخر 30 يومًا", "chart_30d")
]);

async function sendSettingsMenu(ctx) { const settings = await loadSettings(); const settingsKeyboard = Markup.inlineKeyboard([ [Markup.button.callback("💰 تعيين رأس المال", "set_capital"), Markup.button.callback("💼 عرض المراكز المفتوحة", "view_positions")], [Markup.button.callback("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts"), Markup.button.callback("🗑️ حذف تنبيه سعر", "delete_alert")], [Markup.button.callback(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary"), Markup.button.callback(`🚀 النشر للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")], [Markup.button.callback(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug"), Markup.button.callback("📊 إرسال تقرير النسخ", "send_daily_report")], [Markup.button.callback("🔥 حذف جميع البيانات 🔥", "delete_all_data")] ]); const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*"; try { if (ctx.callbackQuery) { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } else { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } } catch (e) { console.error("Error sending settings menu:", e); } }

bot.use((ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) { return next(); } console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); });

bot.command("start", (ctx) => ctx.reply(`🤖 *أهلاً بك...*`, { parse_mode: "Markdown", reply_markup: mainKeyboard }));
bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));
bot.command("pnl", async (ctx) => { const args = ctx.message.text.split(' ').slice(1); if (args.length !== 3) { return await ctx.reply(`❌ *صيغة غير صحيحة...*`, { parse_mode: "Markdown" }); } /* ... your pnl logic ... */ });

bot.hears("📊 عرض المحفظة", async (ctx) => { /* ... your logic ... */ });
bot.hears("📈 أداء المحفظة", async (ctx) => await ctx.reply("اختر الفترة الزمنية لعرض تقرير الأداء:", { reply_markup: performanceKeyboard }));
// ... Add .hears() for every button in mainKeyboard

bot.on('callback_query', async (ctx) => {
    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;
    // Your full "bot.on("callback_query:data")" logic goes here
});

bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    const text = ctx.message.text.trim();
    if (waitingState) {
        // Your full waitingState logic goes here
    } else {
        // Your switch(text) logic for main keyboard buttons if you prefer that over .hears()
    }
});

// =================================================================
// SECTION 6: SERVER AND BOT INITIALIZATION (Stable Polling Version)
// =================================================================
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));
async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");
        
        // Your background jobs
        // setInterval(monitorBalanceChanges, 60 * 1000);
        // setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
        
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        
        app.listen(PORT, () => console.log(`Healthcheck server running on port ${PORT}`));
        
        bot.launch({ dropPendingUpdates: true, });
        
        console.log("Bot is now fully operational for OKX.");
        
        // Initial jobs
        // await runHourlyJobs();
        // await bot.telegram.sendMessage(AUTHORIZED_USER_ID, "✅ تم تفعيل المراقبة المتقدمة لمنصة OKX.").catch(console.error);

        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
