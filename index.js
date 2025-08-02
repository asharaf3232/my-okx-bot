// =================================================================
// OKX Advanced Analytics Bot - v34.1 (Robust Daily Jobs)
// =================================================================
// هذا الإصدار يحل مشكلة عدم تحديث البيانات اليومية بشكل جذري.
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

// --- إعدادات البوت الأساسية ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- ملفات تخزين البيانات ---
const DATA_DIR = "./data";
const CAPITAL_FILE = `${DATA_DIR}/data_capital.json`;
const ALERTS_FILE = `${DATA_DIR}/data_alerts.json`;
const HISTORY_FILE = `${DATA_DIR}/data_history.json`;
const HOURLY_HISTORY_FILE = `${DATA_DIR}/data_hourly_history.json`;
const SETTINGS_FILE = `${DATA_DIR}/data_settings.json`;
const BALANCE_STATE_FILE = `${DATA_DIR}/data_balance_state.json`;
const POSITIONS_FILE = `${DATA_DIR}/data_positions.json`;
const ALERT_SETTINGS_FILE = `${DATA_DIR}/data_alert_settings.json`;
const PRICE_TRACKER_FILE = `${DATA_DIR}/data_price_tracker.json`;

// --- متغيرات الحالة والمؤشرات ---
let waitingState = null;
let balanceMonitoringInterval = null;
let previousBalanceState = {};
let alertsCheckInterval = null;
let dailyJobsInterval = null;
let hourlyJobsInterval = null;
let movementCheckInterval = null;

// === دوال مساعدة وإدارة الملفات ===
function readJsonFile(filePath, defaultValue) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8')); return defaultValue; } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; } }
function writeJsonFile(filePath, data) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (error) { console.error(`Error writing to ${filePath}:`, error); } }
const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadHourlyHistory = () => readJsonFile(HOURLY_HISTORY_FILE, []);
const saveHourlyHistory = (history) => writeJsonFile(HOURLY_HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: true, autoPostToChannel: false, debugMode: false }); // <-- الملخص اليومي مفعل افتراضيًا
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);
const loadBalanceState = () => readJsonFile(BALANCE_STATE_FILE, {});
const saveBalanceState = (state) => writeJsonFile(BALANCE_STATE_FILE, state);
const loadPositions = () => readJsonFile(POSITIONS_FILE, {});
const savePositions = (positions) => writeJsonFile(POSITIONS_FILE, positions);
const loadAlertSettings = () => readJsonFile(ALERT_SETTINGS_FILE, { global: 5, overrides: {} });
const saveAlertSettings = (settings) => writeJsonFile(ALERT_SETTINGS_FILE, settings);
const loadPriceTracker = () => readJsonFile(PRICE_TRACKER_FILE, { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => writeJsonFile(PRICE_TRACKER_FILE, tracker);

// === دالة مساعدة لإرسال رسائل التشخيص ===
async function sendDebugMessage(message) {
    const settings = loadSettings();
    if (settings.debugMode) {
        try {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" });
        } catch (e) {
            console.error("Failed to send debug message:", e);
        }
    }
}

// === دوال API ===
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }

// === دوال العرض والمساعدة ===
function formatPortfolioMsg(assets, total, capital) {
    const history = loadHistory();
    let dailyPnlText = "   📈 *الربح/الخسارة (يومي):* `لا توجد بيانات كافية`\n";
    if (history.length > 1 && history[history.length - 2] && typeof history[history.length - 2].total === 'number') {
        const previousDayTotal = history[history.length - 2].total;
        const dailyPnl = total - previousDayTotal;
        const dailyPnlPercent = previousDayTotal > 0 ? (dailyPnl / previousDayTotal) * 100 : 0;
        const dailyPnlEmoji = dailyPnl >= 0 ? '🟢' : '🔴';
        const dailyPnlSign = dailyPnl >= 0 ? '+' : '';
        dailyPnlText = `   📈 *الربح/الخسارة (يومي):* ${dailyPnlEmoji} \`${dailyPnlSign}${dailyPnl.toFixed(2)}\` (\`${dailyPnlSign}${dailyPnlPercent.toFixed(2)}%\`)\n`;
    }

    const positions = loadPositions();
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
    let pnlSign = pnl >= 0 ? '+' : '';

    const usdtAsset = assets.find(a => a.asset === 'USDT');
    const usdtValue = usdtAsset ? usdtAsset.value : 0;
    const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;
    const investedPercent = 100 - cashPercent;
    const liquidityText = `   - *السيولة:* 💵 الكاش ${cashPercent.toFixed(1)}% / 📈 المستثمر ${investedPercent.toFixed(1)}%`;

    let msg = `🧾 *ملخص المحفظة التحليلي*\n\n`;
    msg += `*آخر تحديث للأسعار: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *الأداء العام:*\n`;
    msg += `   💰 *القيمة الحالية:* \`$${total.toFixed(2)}\`\n`;
    msg += `   💼 *رأس المال:* \`$${capital.toFixed(2)}\`\n`;
    msg += `   📉 *ربح إجمالي غير محقق:* ${pnlEmoji} \`${pnlSign}${pnl.toFixed(2)}\` (\`${pnlSign}${pnlPercent.toFixed(2)}%\`)\n`;
    msg += dailyPnlText;
    msg += liquidityText + `\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 *الأصــــــــول:*\n`;

    assets.forEach((a, index) => {
        let percent = total > 0 ? ((a.value / total) * 100) : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `╭─ *${a.asset}*\n`;
            msg += `╰─ 💰 *الرصيد:* \`$${a.value.toFixed(2)}\` (\`${percent.toFixed(2)}%\`)`;
        } else {
            const change24hPercent = a.change24h * 100;
            const changeEmoji = change24hPercent >= 0 ? '🟢' : '🔴';
            const changeSign = change24hPercent >= 0 ? '+' : '';

            msg += `╭─ *${a.asset}*\n`;
            msg += `├─ 💰 *القيمة:* \`$${a.value.toFixed(2)}\` (\`${percent.toFixed(2)}%\`)\n`;
            msg += `├─ 📈 *السعر الحالي:* \`$${a.price.toFixed(4)}\`\n`;
            msg += `├─ ⏱️ *تغير (24س):* ${changeEmoji} \`${changeSign}${change24hPercent.toFixed(2)}%\`\n`;
            
            if (positions[a.asset] && positions[a.asset].avgBuyPrice > 0) {
                const avgBuyPrice = positions[a.asset].avgBuyPrice;
                const totalCost = avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0;
                const assetPnlEmoji = assetPnl >= 0 ? '🟢' : '🔴';
                const assetPnlSign = assetPnl >= 0 ? '+' : '';
                msg += `├─ 🛒 *متوسط الشراء:* \`$${avgBuyPrice.toFixed(4)}\`\n`;
                msg += `╰─ 📉 *ربح غير محقق:* ${assetPnlEmoji} \`${assetPnlSign}${assetPnl.toFixed(2)}\` (\`${assetPnlSign}${assetPnlPercent.toFixed(2)}%\`)`;
            } else {
                msg += `╰─ 🛒 *متوسط الشراء:* لم يتم تسجيله`;
            }
        }
        if (index < assets.length - 1) {
            msg += `\n━━━━━━━━━━━━━━━━━━━━`;
        }
    });
    return msg;
}

function createChartUrl(history, periodLabel) {
    if (history.length < 2) return null;
    const labels = history.map(h => h.label);
    const data = history.map(h => h.total.toFixed(2));
    const chartConfig = {
        type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: 'rgba(75, 192, 192, 0.2)', borderColor: 'rgb(75, 192, 192)', tension: 0.1 }] },
        options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
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

// === دوال منطق البوت والمهام المجدولة ===
async function getMarketPrices() {
    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') { console.error("Failed to fetch market prices:", tickersJson.msg); return null; }
        const prices = {};
        tickersJson.data.forEach(t => { prices[t.instId] = { price: parseFloat(t.last), change24h: parseFloat(t.chg24h) || 0 }; });
        return prices;
    } catch (error) { console.error("Exception in getMarketPrices:", error); return null; }
}

async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` };
        let assets = [], total = 0;
        json.data[0]?.details?.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                const price = priceData.price;
                const value = amount * price;
                if (value >= 1) { assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h }); }
                total += value;
            }
        });
        const filteredAssets = assets.filter(a => a.value >= 1);
        filteredAssets.sort((a, b) => b.value - a.value);
        return { assets: filteredAssets, total };
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > 1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function monitorBalanceChanges() { /* ... الكود هنا لم يتغير ... */ }
async function getInstrumentDetails(instId) { /* ... الكود هنا لم يتغير ... */ }
async function checkPriceAlerts() { /* ... الكود هنا لم يتغير ... */ }

async function runDailyJobs() {
    try {
        console.log("Attempting to run daily jobs...");
        const settings = loadSettings();
        if (!settings.dailySummary) {
            console.log("Daily summary is disabled in settings. Skipping.");
            return;
        }
        const prices = await getMarketPrices();
        if (!prices) {
            console.error("Daily Jobs: Failed to get prices.");
            return;
        }
        const { total, error } = await getPortfolio(prices);
        if (error) {
            console.error("Daily Jobs Error:", error);
            return;
        }
        const history = loadHistory();
        const date = new Date().toISOString().slice(0, 10);
        const todayRecordIndex = history.findIndex(h => h.date === date);

        if (todayRecordIndex > -1) {
            history[todayRecordIndex].total = total;
        } else {
            history.push({ date: date, total: total });
        }
        
        if (history.length > 35) history.shift();
        saveHistory(history);
        console.log(`[✅ Daily Summary Recorded]: ${date} - $${total.toFixed(2)}`);
    } catch(e) {
        console.error("CRITICAL ERROR in runDailyJobs:", e);
    }
}
async function runHourlyJobs() { /* ... الكود هنا لم يتغير ... */ }
async function checkPriceMovements() { /* ... الكود هنا لم يتغير ... */ }

// --- لوحات المفاتيح والقوائم والمعالجات (بدون تغيير) ---
const mainKeyboard = new Keyboard().text("📊 عرض المحفظة").text("📈 أداء المحفظة").row().text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row().text("🧮 حاسبة الربح والخسارة").row().text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();
async function sendSettingsMenu(ctx) { /* ... */ }
async function sendPositionsMenu(ctx) { /* ... */ }
async function sendMovementAlertsMenu(ctx) { /* ... */ }
bot.use(async (ctx, next) => { /* ... */ });
bot.command("start", async (ctx) => { /* ... */ });
bot.command("settings", async (ctx) => { /* ... */ });
bot.command("pnl", async (ctx) => { /* ... */ });
bot.command("avg", async (ctx) => { /* ... */ });
bot.on("callback_query:data", async (ctx) => { /* ... */ });
bot.on("message:text", async (ctx) => { /* ... */ });

// --- بدء تشغيل البوت ---
async function startBot() {
    console.log("Starting bot...");
    previousBalanceState = loadBalanceState();
    if (Object.keys(previousBalanceState).length > 0) { console.log("Initial balance state loaded."); } 
    else { console.log("No previous balance state found."); }
    
    // تشغيل المهام فورًا عند البدء لضمان تسجيل البيانات حتى بعد إعادة التشغيل
    runDailyJobs(); 
    runHourlyJobs();

    balanceMonitoringInterval = setInterval(monitorBalanceChanges, 1 * 60 * 1000);
    alertsCheckInterval = setInterval(checkPriceAlerts, 5 * 60 * 1000);
    dailyJobsInterval = setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
    hourlyJobsInterval = setInterval(runHourlyJobs, 1 * 60 * 60 * 1000);
    movementCheckInterval = setInterval(checkPriceMovements, 10 * 60 * 1000);

    app.use(express.json());
    app.use(`/${bot.token}`, webhookCallback(bot, "express"));
    app.listen(PORT, () => { console.log(`Bot server listening on port ${PORT}`); });
}

startBot().catch(err => {
    console.error("FATAL ERROR: Failed to start bot:", err)
});
