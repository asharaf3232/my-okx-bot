const express = require("express");
const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- State Variables ---
let waitingState = null;

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS
// =================================================================
const getCollection = (collectionName) => getDB().collection(collectionName);
async function getConfig(id, defaultValue = {}) {
    try {
        const doc = await getCollection("configs").findOne({ _id: id });
        return doc ? doc.data : defaultValue;
    } catch (e) {
        console.error(`Error in getConfig for id: ${id}`, e);
        return defaultValue;
    }
}
async function saveConfig(id, data) {
    try {
        await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true });
    } catch (e) {
        console.error(`Error in saveConfig for id: ${id}`, e);
    }
}
async function saveClosedTrade(tradeData) {
    try {
        await getCollection("tradeHistory").insertOne(tradeData);
    } catch (e) {
        console.error("Error in saveClosedTrade:", e);
    }
}
async function getHistoricalPerformance(asset) {
    try {
        const history = await getCollection("tradeHistory").find({ asset: asset }).toArray();
        if (history.length === 0) {
            return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 };
        }
        
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0);
        const winningTrades = history.filter(trade => trade.pnl > 0).length;
        const losingTrades = history.filter(trade => trade.pnl <= 0).length;
        const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0);
        const avgDuration = history.length > 0 ? totalDuration / history.length : 0;
        return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration };
    } catch (e) {
        console.error(`Error fetching historical performance for ${asset}:`, e);
        return null;
    }
}
async function saveVirtualTrade(tradeData) {
    try {
        const tradeWithId = { ...tradeData, _id: new crypto.randomBytes(16).toString("hex") };
        await getCollection("virtualTrades").insertOne(tradeWithId);
        return tradeWithId;
    } catch (e) {
        console.error("Error saving virtual trade:", e);
    }
}
async function getActiveVirtualTrades() {
    try {
        return await getCollection("virtualTrades").find({ status: 'active' }).toArray();
    } catch (e) {
        console.error("Error fetching active virtual trades:", e);
        return [];
    }
}
async function updateVirtualTradeStatus(tradeId, status, finalPrice) {
    try {
        await getCollection("virtualTrades").updateOne({ _id: tradeId }, { $set: { status: status, closePrice: finalPrice, closedAt: new Date() } });
    } catch (e) {
        console.error(`Error updating virtual trade ${tradeId}:`, e);
    }
}

const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
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
function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals);
    return number.toFixed(decimals);
}
async function sendDebugMessage(message) {
    const settings = await loadSettings();
    if (settings.debugMode) {
        try {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" });
        } catch (e) {
            console.error("Failed to send debug message:", e);
        }
    }
}
function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

// =================================================================
// SECTION 2: API AND DATA PROCESSING FUNCTIONS
// =================================================================
async function getMarketPrices() {
    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') {
            console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg);
            return null;
        }
        const prices = {};
        tickersJson.data.forEach(t => {
            if (t.instId.endsWith('-USDT')) {
                const lastPrice = parseFloat(t.last);
                const openPrice = parseFloat(t.open24h);
                let change24h = 0;
                if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice;
                prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) };
            }
        });
        return prices;
    } catch (error) {
        console.error("Exception in getMarketPrices:", error.message);
        return null;
    }
}
async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) {
            return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة من المنصة'}` };
        }
        
        let assets = [], total = 0, usdtValue = 0;
        json.data[0].details.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                const value = amount * priceData.price;
                total += value;
                if (asset.ccy === "USDT") {
                    usdtValue = value;
                }
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h });
                }
            }
        });
        
        assets.sort((a, b) => b.value - a.value);
        return { assets, total, usdtValue };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}
async function getBalanceForComparison() {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) return null;
        
        const balanceMap = {};
        json.data[0].details.forEach(asset => {
            balanceMap[asset.ccy] = parseFloat(asset.eq);
        });
        return balanceMap;
    } catch (error) {
        console.error("Exception in getBalanceForComparison:", error);
        return null;
    }
}
async function getInstrumentDetails(instId) {
    try {
        const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const tickerJson = await tickerRes.json();
        if (tickerJson.code !== '0' || !tickerJson.data[0]) return { error: `لم يتم العثور على العملة.` };
        const tickerData = tickerJson.data[0];
        return {
            price: parseFloat(tickerData.last),
            high24h: parseFloat(tickerData.high24h),
            low24h: parseFloat(tickerData.low24h),
            vol24h: parseFloat(tickerData.volCcy24h),
        };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}
async function getHistoricalCandles(instId, limit = 100) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) return [];
        return json.data.map(c => parseFloat(c[4])).reverse();
    } catch (e) {
        console.error(`Exception in getHistoricalCandles for ${instId}:`, e);
        return [];
    }
}
function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0);
    return sum / period;
}
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        diff > 0 ? gains += diff : losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgLoss = (avgLoss * (period - 1) - diff) / period;
            avgGain = (avgGain * (period - 1)) / period;
        }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}
async function getTechnicalAnalysis(instId) {
    const closes = await getHistoricalCandles(instId, 51);
    if (closes.length < 51) return { error: "بيانات الشموع غير كافية." };
    return { rsi: calculateRSI(closes), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) };
}
function calculatePerformanceStats(history) {
    if (history.length < 2) return null;
    const values = history.map(h => h.total);
    const startValue = values[0];
    const endValue = values[values.length - 1];
    const pnl = endValue - startValue;
    const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0;
    const maxValue = Math.max(...values);
    const minValue = Math.min(...values);
    const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length;
    return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue };
}
function createChartUrl(history, periodLabel, pnl) {
    if (history.length < 2) return null;
    const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)';
    const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)';
    const labels = history.map(h => h.label);
    const data = history.map(h => h.total.toFixed(2));
    const chartConfig = {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }]
        },
        options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
}

// =================================================================
// SECTION 3: FORMATTING AND MESSAGE GENERATION FUNCTIONS 
// =================================================================
function formatPrivateBuy(details) {
    const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details;
    const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0;
    let msg = `*مراقبة الأصول 🔬:*\n**عملية استحواذ جديدة 🟢**\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`;
    msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`;
    msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`;
    msg += ` ▪️ **الكمية المضافة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`;
    msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${formatNumber(tradeValue)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`;
    msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`;
    msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`;
    msg += ` ▪️ **السيولة المتبقية (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`;
    msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}
function formatPublicBuy(details) {
    const { asset, price, oldTotalValue, tradeValue, oldUsdtValue, newCashPercent } = details;
    const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0;
    const cashConsumedPercent = (oldUsdtValue > 0) ? (tradeValue / oldUsdtValue) * 100 : 0;
    let msg = `*💡 توصية جديدة: بناء مركز في ${asset} 🟢*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*الأصل:* \`${asset}/USDT\`\n`;
    msg += `*سعر الدخول الحالي:* \`$${formatNumber(price, 4)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`;
    msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${formatNumber(tradeSizePercent)}\%` من المحفظة لهذه الصفقة.\n`;
    msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${formatNumber(cashConsumedPercent)}\%` من السيولة النقدية المتاحة.\n`;
    msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${formatNumber(newCashPercent)}\%` من المحفظة.\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nنرى في هذه المستويات فرصة واعدة. المراقبة مستمرة، وسنوافيكم بتحديثات إدارة الصفقة.\n`;
    msg += `#توصية #${asset}`;
    return msg;
}
function formatPrivateSell(details) {
    const { asset, price, amountChange, position } = details;
    const soldPercent = position.totalAmountBought > 0 ? (Math.abs(amountChange) / position.totalAmountBought) * 100 : 0;
    
    const partialPnl = (price - position.avgBuyPrice);
    const partialPnlPercent = position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0;
    let msg = `*مراقبة الأصول 🔬:*\n**مناورة تكتيكية 🟠**\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`;
    msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`;
    msg += ` ▪️ *سعر البيع الجزئي:* \`$${formatNumber(price, 4)}\`\n`;
    msg += ` ▪️ *الكمية المخففة:* \`${formatNumber(Math.abs(amountChange), 6)}\`\n`;
    msg += ` ▪️ *الربح المحقق:* \`${partialPnl >= 0 ? '+' : ''}${formatNumber(partialPnl)}\` (${partialPnlPercent >= 0 ? '+' : ''}${formatNumber(partialPnlPercent)}%\` 🟢.\n`;
    msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحاً بالكمية المتبقية.\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nخطوة استباقية لإدارة المخاطر وحماية رأس المال. نستمر في متابعة الأهداف الأعلى.\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}
function formatPublicSell(details) {
    const { asset, price, amountChange, position } = details;
    const soldPercent = position.totalAmountBought > 0 ? (Math.abs(amountChange) / position.totalAmountBought) * 100 : 0;
    
    const partialPnl = (price - position.avgBuyPrice);
    const partialPnlPercent = position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0;
    let msg = `*⚙️ تحديث التوصية: إدارة مركز ${asset} 🟠*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`;
    msg += `🔸 **نوع العملية:** بيع جزئي\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`;
    msg += ` ▪️ *سعر البيع الجزئي:* \`$${formatNumber(price, 4)}\`\n`;
    msg += ` ▪️ *الكمية المخففة:* \`${formatNumber(Math.abs(amountChange), 6)}\`\n`;
    msg += ` ▪️ *الربح المحقق:* \`${partialPnl >= 0 ? '+' : ''}${formatNumber(partialPnl)}\` (${partialPnlPercent >= 0 ? '+' : ''}${formatNumber(partialPnlPercent)}%\` 🟢.\n`;
    msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحاً بالكمية المتبقية.\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nخطوة استباقية لإدارة المخاطر وحماية رأس المال. نستمر في متابعة الأهداف الأعلى.\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}
function formatPrivateCloseReport(details) {
    const { asset, avgBuyPrice, avgSellPrice, pnl, pnlPercent, durationDays, highestPrice, lowestPrice } = details;
    const pnlSign = pnl >= 0 ? '+' : '';
    let msg = `*ملف المهمة المكتملة 📂:*\n**تم إغلاق مركز ${asset} بنجاح ✅**\n━━━━━━━━━━━━━━━━━━━━━━\n*النتيجة النهائية للمهمة:*\n`;
    msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`;
    msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`;
    msg += ` ▪️ **صافي الربح/الخسارة:** ${pnl >= 0 ? '🟢' : '🔴'} \`${pnlSign}${formatNumber(pnl)}\` (${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
    msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${formatNumber(durationDays, 1)} يوم\`\n`;
    msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${formatNumber(highestPrice, 4)}\`\n`;
    msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${formatNumber(lowestPrice, 4)}\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*بتاريخ الإغلاق:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}
function formatPublicClose(details) {
    const { asset, pnlPercent, durationDays, avgBuyPrice, avgSellPrice } = details;
    const pnlSign = pnlPercent >= 0 ? '+' : '';
    let msg = `*🏆 النتيجة النهائية لتوصية ${asset} ✅*\n━━━━━━━━━━━━━━━━━━━━━━\n*الأصل:* \`${asset}/USDT\`\n*الحالة:* **تم إغلاق الصفقة بالكامل.**\n━━━━━━━━━━━━━━━━━━━━━━\n*ملخص أداء التوصية:*\n`;
    msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`;
    msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`;
    msg += ` ▪️ **العائد النهائي على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\` ${pnlPercent >= 0 ? '🟢' : '🔴'}\n`;
    msg += ` ▪️ **مدة التوصية:** \`${formatNumber(durationDays, 1)} يوم\`\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n*الخلاصة:*\n`;
    if (pnlPercent >= 0) {
        msg += `صفقة موفقة أثبتت أن الصبر على التحليل يؤتي ثماره.\n`;
    } else {
        msg += `الخروج بانضبطق وفقًا للخطة هو نجاح بحد ذاته. نحافظ على رأس المال للفرصة القادمة.\n`;
    }
    msg += `\nنبارك لمن اتبع التوصية. نستعد الآن للبحث عن الفرصة التالية.\n`;
    msg += `#نتائجتوصيات #${asset}`;
    return msg;
}
function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    let dailyPnlText = " ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n";
    let totalValue24hAgo = 0;
    assets.forEach(asset => {
        if (asset.asset === 'USDT') totalValue24hAgo += asset.value;
        else if (asset.change24h !== undefined && asset.price > 0) totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h));
        else totalValue24hAgo += asset.value;
    });
    if (totalValue24hAgo > 0) {
        const dailyPnl = total - totalValue24hAgo;
        const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100;
        const sign = dailyPnl >= 0 ? '+' : '';
        dailyPnlText = ` ▫️ *الأداء اليومي (24س):* ${dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${sign}${formatNumber(dailyPnl)}\` (\`${sign}${formatNumber(dailyPnlPercent)}%\`)\n`;
    }
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const statusEmoji = pnl >= 0 ? '🟢' : '🔴';
    const statusText = pnl >= 0 ? 'ربح' : 'خسارة';
    let msg = "⚡ *إحصائيات سريعة*\n\n";
    msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`;
    msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`;
    msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`;
    msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n\n`;
    msg += `⏰ *آخر تحديث:* ${new Date().toLocaleTimeString("ar-EG")}`;
    return msg;
}
async function formatAdvancedMarketAnalysis() {
    const prices = await getMarketPrices();
    if (!prices) return "❌ فشل جلب بيانات السوق.";
    const marketData = Object.entries(prices)
        .map(([instId, data]) => ({ instId, ...data }))
        .filter(d => d.volCcy24h > 10000 && d.change24h !== undefined);
    marketData.sort((a, b) => b.change24h - a.change24h);
    const topGainers = marketData.slice(0, 5);
    const topLosers = marketData.slice(-5).reverse();
    marketData.sort((a, b) => b.volCcy24h - a.volCcy24h);
    const highVolume = marketData.slice(0, 5);

    let msg = `🚀 *تحليل السوق المتقدم* | ${new Date().toLocaleDateString("ar-EG")}\n━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += "📈 *أكبر الرابحين (24س):*\n" + topGainers.map(c => `  - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\```).join('\n') + "\n\n";
    msg += "📉 *أكبر الخاسرين (24س):*\n" + topLosers.map(c => `  - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\```).join('\n') + "\n\n";
    msg += "📊 *الأعلى في حجم التداول:*\n" + highVolume.map(c => `  - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`).join('\n') + "\n\n";
    msg += "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق.";
    return msg;
}
async function formatQuickStats(assets, total, capital) {
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    const statusEmoji = pnl >= 0 ? '🟢' : '🔴';
    const statusText = pnl >= 0 ? 'ربح' : 'خسارة';
    let msg = "⚡ *إحصائيات سريعة*\n\n";
    msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`;
    msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`;
    msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`;
    msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n\n`;
    msg += `⏰ *آخر تحديث:* ${new Date().toLocaleTimeString("ar-EG")}`;
    return msg;
}

// =================================================================
// SECTION 4: BACKGROUND JOBS
// =================================================================
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("Checking balance changes...");
        const previousState = await loadBalanceState();
        const previousBalances = previousState.balances || {};
        const oldTotalValue = previousState.totalValue || 0;
        
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) return;
        
        const prices = await getMarketPrices();
        if (!prices) return;
        
        const { assets: newAssets, total: newTotalValue, error } = await getPortfolio(prices);
        if (newTotalValue === undefined) return;
        if (Object.keys(previousBalances).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            return;
        }
        const allAssets = new Set([...Object.keys(previousBalances), ...Object.keys(currentBalance)]);
        let stateNeedsUpdate = false;
        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            
            const prevAmount = previousBalances[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price || isNaN(priceData.price) || Math.abs(difference * priceData.price) < 1) continue;
            stateNeedsUpdate = true;
            const { analysisResult } = await updatePositionAndAnalyze(asset, difference, priceData.price, newTotalValue);
            if (analysisResult.type === 'none') continue;
            const tradeValue = Math.abs(difference * priceData.price);
            const newAssetData = newAssets.find(a => a.asset === asset);
            const newAssetValue = newAssetData ? newAssetData.value : 0;
            const newAssetWeight = newTotalValue > 0 ? (newAssetValue / newTotalValue) * 100 : 0;
            const newCashPercent = newTotalValue > 0 ? (newUsdtValue / newTotalValue) * 100 : 0;
            const baseDetails = {
                asset, price: priceData.price, amountChange: difference, tradeValue,
                oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent,
                oldUsdtValue, newCashPercent, position: analysisResult.data.position
            };
            const details = {
                ...baseDetails,
                oldTotalValue: oldTotalValue,
                newAssetWeight: newAssetWeight,
                newUsdtValue: newUsdtValue,
                newCashPercent: newCashPercent
            };
            
            // Send notifications based on operation type
            if (analysisResult.type === 'buy') {
                const privateMessage = formatPrivateBuy(details);
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
                if (settings.autoPostToChannel) {
                    const publicMessage = formatPublicBuy(details);
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" });
                }
            } else if (analysisResult.type === 'sell') {
                const privateMessage = formatPrivateSell(details);
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" });
                if (settings.autoPostToChannel) {
                    const publicMessage = formatPublicSell(details);
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" });
                }
            } else if (analysisResult.type === 'close') {
                if (settings.autoPostToChannel) {
                    const publicMessage = formatPublicClose(analysisResult.data);
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" });
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, formatPrivateCloseReport(analysisResult.data), { parse_mode: "Markdown" });
                } else {
                    const confirmationKeyboard = new InlineKeyboard().text("✅ نعم، انشر التقرير", "publish_report").text("❌ لا، تجاهل", "ignore_report");
                    const hiddenMarker = `\n<REPORT>${JSON.stringify(publicMessage)}</REPORT>`;
                    const confirmationMessage = `*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*\n\n${privateMessage}${hiddenMarker}`;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, confirmationMessage, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
                }
            }
        }
        if (stateNeedsUpdate) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            await sendDebugMessage("State updated after balance change.");
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
    }
}

async function trackPositionHighLow() {
    try {
        const positions = await loadPositions();
        if (Object.keys(positions).length === 0) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        let positionsUpdated = false;
        for (const symbol in positions) {
            const position = positions[symbol];
            const currentPrice = prices[`${symbol}-USDT`]?.price;
            if (currentPrice) {
                if (!position.highestPrice || currentPrice > position.highestPrice) {
                    position.highestPrice = currentPrice;
                    positionsUpdated = true;
                }
                if (!position.lowestPrice || currentPrice < position.lowestPrice) {
                    position.lowestPrice = currentPrice;
                    positionsUpdated = true;
                }
            }
        }
        if (positionsUpdated) {
            await savePositions(positions);
            await sendDebugMessage("Updated position high/low prices.");
        }
    } catch(e) {
        console.error("CRITICAL ERROR in trackPositionHighLow:", e);
    }
}

async function checkPriceAlerts() {
    try {
        const alerts = await loadAlerts();
        if (alerts.length === 0) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        const alertSettings = await loadAlertSettings();
        let triggered = false;
        for (const alert of alerts) {
            const currentPrice = prices[alert.instId]?.price;
            if (currentPrice === undefined) { 
                remainingAlerts.push(alert); 
                continue; 
            }
            if ((alert.condition === '>' && currentPrice > alert.price) || (alert.condition === '<' && currentPrice < alert.price)) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تنبيه سعر!* \`${alert.instId}\`\nالشرط: ${alert.condition} ${alert.price}\nالسعر الحالي: \`${currentPrice}\``, { parse_mode: "Markdown" });
                triggered = true;
            } else {
                remainingAlerts.push(alert);
            }
        }
        if (triggered) await saveAlerts(remainingAlerts);
    } catch (error) {
        console.error("Error in checkPriceAlerts:", error);
    }
}
async function checkPriceMovements() {
    try {
        await sendDebugMessage("Checking price movements...");
        const alertSettings = await loadAlertSettings();
        const priceTracker = await loadPriceTracker();
        if (!priceTracker) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        const { assets, total: currentTotalValue, error } = await getPortfolio(prices);
        if (error || currentTotalValue === undefined) return;
        if (priceTracker.totalPortfolioValue === 0) {
            priceTracker.totalPortfolioValue = currentTotalValue;
            assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; });
            await savePriceTracker(priceTracker);
            return;
        }
        let trackerUpdated = false;
        for (const asset of assets) {
            if (asset.asset === 'USDT' || !asset.price) continue;
            const lastPrice = priceTracker.assets[asset.asset];
            if (lastPrice) {
                const changePercent = ((asset.price - lastPrice) / lastPrice) * 100;
                const threshold = alertSettings.overrides[asset.asset] || alertSettings.global;
                if (Math.abs(changePercent) >= threshold) {
                    const movementText = changePercent > 0 ? 'صعود' : 'هبوط';
                    const message = `📈 *تنبيه حركة سعر لأصل!* \`${asset.asset}\`\n*الحركة:* ${movementText} بنسبة \`${formatNumber(changePercent)}%\`\n*السعر الحالي:* \`$${formatNumber(asset.price, 4)}\``;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                    priceTracker.assets[asset.asset] = asset.price; 
                    trackerUpdated = true;
                }
            } else {
                priceTracker.assets[asset.asset] = asset.price;
                trackerUpdated = true;
            }
        }
        if (trackerUpdated) await savePriceTracker(priceTracker);
    } catch (e) {
        console.error("CRITICAL ERROR in checkPriceMovements:", e);
    }
}
async function runDailyJobs() {
    try {
        const settings = await loadSettings();
        if (!settings.dailySummary) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        const { total } = await getPortfolio(prices);
        if (total === undefined) return;
        const history = await loadHistory();
        const date = new Date().toISOString().slice(0, 10);
        const todayIndex = history.findIndex(h => h.date === date);
        if (todayIndex > -1) history[todayIndex].total = total;
        else history.push({ date, total });
        if (history.length > 35) history.shift();
        await saveHistory(history);
        console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`);
    } catch (e) {
        console.error("CRITICAL ERROR in runDailyJobs:", e);
    }
}
async function runHourlyJobs() {
    try {
        const prices = await getMarketPrices();
        if (!prices) return;
        const { total } = await getPortfolio(prices);
        if (total === undefined) return;
        const history = await loadHourlyHistory();
        const hourLabel = new Date().toISOString().slice(0, 13);
        const existingIndex = history.findIndex(h => h.label === hourLabel);
        if (existingIndex > -1) history[existingIndex].total = total;
        else history.push({ label: hourLabel, total });
        if (history.length > 72) history.splice(0, history.length - 72);
        await saveHourlyHistory(history);
    } catch (e) {
        console.error("Error in hourly jobs:", e);
    }
}
async function monitorVirtualTrades() {
    const activeTrades = await getActiveVirtualTrades();
    if (activeTrades.length === 0) return;
    const prices = await getMarketPrices();
    if (!prices) return;
    for (const trade of activeTrades) {
        const currentPrice = prices[trade.instId]?.price;
        if (!currentPrice) continue;
        let finalStatus = null;
        let pnl = 0;
        let finalPrice = 0;
        if (currentPrice >= trade.targetPrice) {
            finalPrice = trade.targetPrice;
            pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = 'completed';
            const profitPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0;
            const msg = `🎯 *الهدف تحقق (توصية افتراضية)!* ✅\n\n` +
                        `*العملة:* \`${trade.instId}\`\n` +
                        `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                        `*سعر الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n\n` +
                        `💰 *الربح المحقق:* \`+$${formatNumber(pnl)}\` (+${formatNumber(profitPercent)}%)\n\n` +
                        `*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        }
        else if (currentPrice <= trade.stopLossPrice) {
            finalPrice = trade.stopLossPrice;
            pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = 'stopped';
            const lossPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0;
            const msg = `🛑 *تم تفعيل وقف الخسارة (توصية افتراضية)!* 🔻\n\n` +
                        `*العملة:* \`${trade.instId}\`\n` +
                        `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                        `*سعر الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n\n` +
                        `💸 *الخسارة:* \`-$${formatNumber(Math.abs(pnl))}\` (${formatNumber(lossPercent)}%)\n\n` +
                        `*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        }
        if (finalStatus) {
            await updateVirtualTradeStatus(trade._id, finalStatus, finalPrice);
        }
    }
}

// =================================================================
// SECTION 5: BOT SETUP, KEYBOARDS, AND HANDLERS
// =================================================================
bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
    }
});
bot.command("start", (ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت OKX التحليلي المتكامل، مساعدك الذكي لإدارة وتحليل محفظتك الاستثمارية.*\n\n` +
                          `*الإصدار: v106 - The Accountability Fix*\n\n` +
                          `🎯 *أنا هنا لمساعدتك على:*\n` +
                          `- 📊 تتبع أداء محفظتك لحظة بلحظة\n` +
                          `- 🚀 تحليل اتجاهات السوق والفرص المتاحة\n` +
                          `- 💡 إضافة ومتابعة توصيات افتراضية\n` +
                          `- 🔔 ضبط تنبيهات ذكية للأسعار والحركات الهامة\n\n` +
                          `👋 *كيف تبدأ؟*\n` +
                          `1️⃣ اضغط على زر "📊 عرض المحفظة"\n` +
                          `2️⃣ اكتشف الميزات عبر لوحة التحكم\n` +
                          `3️⃣ استخدم محادثات التفاعل لتسهيل العمليات\n\n` +
                          `*هل أنت مستعد؟ لنبدأ!*\n`;
    ctx.reply(welcomeMessage, { parse_mode: "Markdown" });
});
bot.command("settings", async (ctx) => {
    await sendSettingsMenu(ctx);
});
bot.command("pnl", (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(`❌ صيغة غير صحيحة. مثال: \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``, { parse_mode: "Markdown" });
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ خطأ: تأكد من أن جميع القيم هي أرقام موجبة.");
    }
    const investment = buyPrice * quantity;
    const saleValue = sellPrice * quantity;
    const pnl = saleValue - investment;
    const pnlPercent = investment > 0 ? (pnl / investment) * 100 : 0;
    const sign = pnl >= 0 ? '+' : '';
    await ctx.reply(`🧮 *نتيجة حساب الربح والخسارة*\n\n` +
                  `▪️ *صافي الربح/الخسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n\n` +
                  `▪️ *متوسط الشراء:* \`$${formatNumber(buyPrice, 4)}\`\n` +
                  `▪️ *متوسط السعر الخروج:* \`$${formatNumber(sellPrice, 4)}\`\n\n` +
                  `▪️ *الربح/الخسارة:* ${pnl >= 0 ? '🟢' : '🔴'} \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)`);
});
bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    try {
        if (data.startsWith("chart_")) {
            const period = data.split('_')[1];
            await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء...");
            let history, periodLabel, pnl;
            if (period == '24h') { 
                history = await loadHourlyHistory(); 
                periodLabel = "آخر 24 ساعة"; 
                pnl = history.slice(-24).reduce((sum, h) => sum + h.total, 0);
            } else if (period == '7d') { 
                history = await loadHistory(); 
                periodLabel = "آخر 7 أيام"; 
                pnl = history.slice(-7).reduce((sum, h) => sum + h.total, 0);
            } else if (period == '30d') { 
                history = await loadHistory(); 
                periodLabel = "آخر 30 يومًا"; 
                pnl = history.slice(-30).reduce((sum, h) => sum + h.total, 0);
            } else {
                return;
            }
            
            if (!history || history.length < 2) { 
                await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); 
                return; 
            }
            const stats = calculatePerformanceStats(history);
            if (!stats) { 
                await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); 
                return; 
            }
            const chartUrl = createChartUrl(history, periodLabel, pnl);
            const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` +
                          `📈 *النتيجة:* ${stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${stats.pnl >= 0 ? '+' : ''}${formatNumber(stats.pnl)}\` (\`${stats.pnl >= 0 ? '+' : ''}${formatNumber(stats.pnlPercent)}%\`)\n` +
                          `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n` +
                          `📝 *ملخص إحصائيات الفترة:*\n` +
                          ` ▫️ *أعلى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.maxValue)}\`\n` +
                          ` ▫️ *أدنى قاع سعري مسجل:* \`$${formatNumber(stats.minValue)}\`\n` +
                          ` ▫️ *متوسط قيمة المحفظة:* \`$${formatNumber(stats.avgValue)}\`\n\n` +
                          `*التقرير تم إنشاؤه في: ${new Date().toLocaleDateString("en-GB").replace(/\//g, '.')}*`;
            await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" }); 
            await ctx.deleteMessage(); 
            return;
        }
        
        switch(data) {
            case "add_virtual_trade":
                waitingState = 'ask_virtual_asset';
                await ctx.reply("✍️ *لإضافة توصية افتراضية، أخبرني العملة التي تريد مراقبتها (مثال: BTC-USDT):*", { parse_mode: "Markdown" });
                break;
            case "track_virtual_trades":
                await ctx.reply("⏳ جاري تجهيز التوصيات النشطة...");
                const activeTrades = await getActiveVirtualTrades();
                if (activeTrades.length === 0) {
                    await ctx.reply("✅ لا توجد توصيات افتراضية نشطة حاليا.", { reply_markup: virtualTradeKeyboard });
                    return;
                }
                const prices = await getMarketPrices();
                if (!prices) {
                    await ctx.reply("❌ فشل جلب أسعار السوق.", { reply_markup: virtualTradeKeyboard });
                    return;
                }
                let reportMsg = "📈 *متابعة حية للتوصيات النشطة:*\n" + "━━━━━━━━━━━━━━━━━━━━\n";
                for (const trade of activeTrades) {
                    const currentPrice = prices[trade.instId]?.price;
                    if (!currentPrice) {
                        reportMsg += `*${trade.instId}:* `لا يمكن جلب السعر الحالي.\`\n`;
                    } else {
                        const pnl = (currentPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
                        const pnlPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0;
                        const sign = pnl >= 0 ? '+' : '';
                        reportMsg += `*${trade.instId}* ${pnl >= 0 ? '🟢' : '🔴'}\n` +
                                   ` ▫️ *الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                                   ` ▫️ *الحالي:* \`$${formatNumber(currentPrice, 4)}\`\n` +
                                   ` ▫️ *ربح/خسارة:* \`${sign}${formatNumber(pnl)}\` (${sign}${formatNumber(pnlPercent)}%\`)\n`;
                    }
                    reportMsg += "━━━━━━━━━━━━━━━━━━━━\n";
                }
                await ctx.reply(reportMsg, { parse_mode: "Markdown", reply_markup: virtualTradeKeyboard });
                break;
            case "set_capital":
                waitingState = 'set_capital_amount';
                await ctx.reply("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط):");
                break;
            case "back_to_settings":
                await sendSettingsMenu(ctx);
                break;
            case "manage_movement_alerts":
                await sendMovementAlertsMenu(ctx);
                break;
            case "set_global_alert":
                waitingState = 'set_global_alert_percent';
                await ctx.reply("✍️ يرجى إرسال النسبة العامة الجديدة (مثال: `5`):");
                break;
            case "set_coin_alert":
                waitingState = 'set_coin_alert_details';
                await ctx.reply("✍️ يرجى إرسال رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`");
                break;
            case "view_positions":
                const positions = await loadPositions();
                if (Object.keys(positions).length === 0) { 
                    await ctx.reply("ℹ️ لا توجد مراكز مفتوحة حاليا.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") });
                    break; 
                }
                let posMsg = "📄 *قائمة المراكز المفتوحة:*\n";
                for (const symbol in positions) {
                    const pos = positions[symbol];
                    posMsg += `\n- *${symbol}:* متوسط الشراء \`$${formatNumber(pos.avgBuyPrice, 4)}\``;
                }
                await ctx.reply(posMsg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") });
                break;
            case "delete_alert":
                const alerts = await loadAlerts();
                if (alerts.length === 0) { 
                    await ctx.reply("ℹ️ لا توجد تنبيهات مسجلة.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") });
                    break; 
                }
                let alertMsg = "🗑️ *اختر التنبيه للحذف:*\n\n";
                alerts.forEach((alert, i) => { 
                    alertMsg += `*${i + 1}.* \`${alert.instId} ${alert.condition} ${alert.price}\`\n`; 
                });
                alertMsg += "\n*أرسل رقم التنبيه الذي تود حذفه.*";
                waitingState = 'delete_alert_number';
                await ctx.reply(alertMsg);
                break;
            case "toggle_summary":
                const settings = await loadSettings();
                settings.dailySummary = !settings.dailySummary;
                await saveSettings(settings);
                await sendSettingsMenu(ctx);
                break;
            case "toggle_autopost":
                const settings = await loadSettings();
                settings.autoPostToChannel = !settings.autoPostToChannel;
                await saveSettings(settings);
                await sendSettingsMenu(ctx);
                break;
            case "toggle_debug":
                const settings = await loadSettings();
                settings.debugMode = !settings.debugMode;
                await saveSettings(settings);
                await sendSettingsMenu(ctx);
                break;
            case "delete_all_data":
                waitingState = 'confirm_delete_all';
                await ctx.reply("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!\n\n*أرسل "تأكيد الحذف" للإكمال:*", { parse_mode: "Markdown" });
                break;
        }
    } catch (e) {
        console.error("Error in callback_query handler:", e);
    }
});
bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        
        switch (state) {
            case 'set_capital_amount':
                const amount = parseFloat(text);
                if (!isNaN(amount) && amount >= 0) {
                    await saveCapital(amount);
                    await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
                } else {
                    await ctx.reply("❌ مبلغ غير صالح.");
                }
                break;
            case 'set_global_alert_percent':
                const percent = parseFloat(text);
                if (!isNaN(percent) && percent > 0) {
                    const alertSettingsGlobal = await loadAlertSettings();
                    alertSettingsGlobal.global = percent;
                    await saveAlertSettings(alertSettingsGlobal);
                    await ctx.reply(`✅ تم تحديث النسبة العامة لتنبيهات الحركة إلى \`${percent}%\`.`);
                } else {
                     await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجباً.");
                }
                break;
            case 'set_coin_alert_details':
                const partsCoinAlert = text.split(/\s+/);
                if (partsCoinAlert.length !== 2) {
                    await ctx.reply("❌ صيغة غير صحيحة. يرجى إرسال رمز العملة ثم النسبة.");
                    return;
                }
                const [symbolCoinAlert, coinPercentStr] = partsCoinAlert;
                const coinPercent = parseFloat(coinPercentStr);
                if (isNaN(coinPercent) || coinPercent < 0) {
                    await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا.");
                    return;
                }
                const alertSettingsCoin = await loadAlertSettings();
                if (coinPercent === 0) {
                    delete alertSettingsCoin.overrides[symbolCoinAlert.toUpperCase()];
                    await ctx.reply(`✅ تم حذف الإعداد المخصص لـ *${symbolCoinAlert.toUpperCase()}* وستتبع الآن النسبة العامة.`);
                } else {
                    alertSettingsCoin.overrides[symbolCoinAlert.toUpperCase()] = coinPercent;
                    await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbolCoinAlert.toUpperCase()}* إلى \`${coinPercent}%\`.`);
                }
                await saveAlertSettings(alertSettingsCoin);
                break;
            case 'ask_virtual_asset':
                const virtualAsset = text.toUpperCase();
                if (!virtualAsset.includes('-USDT')) {
                    await ctx.reply("❌ العملة يجب أن تنتهي بـUSDT (مثال: BTC-USDT). حاول مرة أخرى:");
                    return;
                }
                waitingState = 'ask_entry_price';
                await ctx.reply(`✅ تم اختيار ${virtualAsset}. الآن، اخبرني سعر الدخول (مثال: 45000):`);
                break;
            case 'ask_entry_price':
                const entryPrice = parseFloat(text);
                if (isNaN(entryPrice) || entryPrice <= 0) {
                    await ctx.reply("❌ السعر غير صالح. حاول مرة أخرى:");
                    return;
                }
                waitingState = 'ask_target_price';
                await ctx.reply(`✅ تم اختيار سعر الدخول: $${formatNumber(entryPrice, 4)}. الآن، اخبرني سعر الهدف (مثال: 48000):`);
                break;
            case 'ask_target_price':
                const targetPrice = parseFloat(text);
                if (isNaN(targetPrice) || targetPrice <= 0) {
                    await ctx.reply("❌ السعر غير صالح. حاول مرة أخرى:");
                    return;
                }
                waitingState = 'ask_stop_loss';
                await ctx.reply(`✅ تم اختيار سعر الهدف: $${formatNumber(targetPrice, 4)}. الآن، اخبرني سعر وقف الخسارة (مثال: 44000):`);
                break;
            case 'ask_stop_loss':
                const stopLossPrice = parseFloat(text);
                if (isNaN(stopLossPrice) || stopLossPrice >= entryPrice) {
                    await ctx.reply("❌ *خطأ:* النسبة غير صالح أو أعلى من سعر الدخول.");
                    return;
                }
                waitingState = 'ask_virtual_amount';
                await ctx.reply(`✅ تم اختيار وقف الخسارة: $${formatNumber(stopLossPrice, 4)}. الآن، اخبرني المبلغ الافتراضي (مثال: 0.1):`);
                break;
            case 'ask_virtual_amount':
                const virtualAmount = parseFloat(text);
                if (isNaN(virtualAmount) || virtualAmount <= 0) {
                    await ctx.reply("❌ المبلغ غير صالح. حاول مرة أخرى:");
                    return;
                }
                // Add virtual trade
                const tradeData = { instId: virtualAsset, entryPrice, targetPrice, stopLossPrice, virtualAmount, status: 'active', createdAt: new Date() };
                const tradeWithId = { ...tradeData, _id: new crypto.randomBytes(16).toString("hex") };
                await saveVirtualTrade(tradeWithId);
                await ctx.reply(`✅ *تمت إضافة التوصية الافتراضية بنجاح.*\n\n` +
                            `🔸 العملة: \`${virtualAsset}\`\n` +
                            `🔸 سعر الدخول: \`$${formatNumber(entryPrice, 4)}\`\n` +
                            `🔸 سعر الهدف: \`$${formatNumber(targetPrice, 4)}\`\n` +
                            `🔸 سعر وقف الخسارة: \`$${formatNumber(stopLossPrice, 4)}\`\n` +
                            `🔸 المبلغ الافتراضي: \`${formatNumber(virtualAmount, 6)}\` ${virtualAsset.split('-')[0]}\n\n` +
                            `✅ *تمت إضافة التوصية بنجاح!*\n\n` +
                            `سيتم إعلامك عند تحقيق الهدف أو تفعيل وقف الخسارة.`);
                break;
        }
    }
});

// =================================================================
// SECTION 6: SERVER AND BOT INITIALIZATION
// =================================================================
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");

        // Schedule background jobs
        setInterval(monitorBalanceChanges, 60 * 1000);
        setInterval(trackPositionHighLow, 60 * 1000);
        setInterval(checkPriceAlerts, 30 * 1000);
        setInterval(checkPriceMovements, 60 * 1000);
        setInterval(runHourlyJobs, 60 * 60 * 1000);
        setInterval(runDailyJobs, 24 * 60 * 1000);
        setInterval(monitorVirtualTrades, 30 * 1000);

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => {
                console.log(`Bot server is running on port ${PORT}`);
            });
        } else {
            console.log("Bot starting with polling...");
            await bot.start();
        }

        console.log("Bot is now fully operational.");
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();