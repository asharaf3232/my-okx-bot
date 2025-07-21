// =================================================================
// OKX Advanced Analytics Bot - Final & Complete Version
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

// --- Bot Core Settings ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- Data Storage Files ---
const CAPITAL_FILE = "data_capital.json";
const ALERTS_FILE = "data_alerts.json";
const TRADES_FILE = "data_trades.json";
const HISTORY_FILE = "data_history.json";
const SETTINGS_FILE = "data_settings.json";

// --- State and Interval Variables ---
let waitingState = null;
let tradeMonitoringInterval = null;
let alertsCheckInterval = null;
let dailyJobsInterval = null;

// === Helper & File Management Functions ===

function readJsonFile(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath));
        return defaultValue;
    } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; }
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) { console.error(`Error writing to ${filePath}:`, error); }
}

const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadLastTrades = () => readJsonFile(TRADES_FILE, {});
const saveLastTrades = (trades) => writeJsonFile(TRADES_FILE, trades);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

// === API Functions ===

function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

async function getPortfolio() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
        const json = await res.json();
        if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` };

        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        const prices = {};
        if (tickersJson.data) tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        let assets = [], total = 0;
        json.data[0]?.details?.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
                const value = amount * price;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price, value, amount });
                    total += value;
                }
            }
        });
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}

async function getInstrumentDetails(instId) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data[0]) return { error: `لم يتم العثور على العملة.` };
        const data = json.data[0];
        return {
            price: parseFloat(data.last), high24h: parseFloat(data.high24h),
            low24h: parseFloat(data.low24h), vol24h: parseFloat(data.volCcy24h),
        };
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}

// === Display & Scheduled Task Functions ===

function formatPortfolioMsg(assets, total, capital) {
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let msg = `📊 *ملخص المحفظة* 📊\n\n`;
    msg += `💰 *القيمة الحالية:* $${total.toFixed(2)}\n`;
    msg += `💼 *رأس المال الأساسي:* $${capital.toFixed(2)}\n`;
    msg += `📈 *الربح/الخسارة (PnL):* ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n`;
    msg += `------------------------------------\n`;
    assets.forEach(a => {
        let percent = total > 0 ? ((a.value / total) * 100).toFixed(2) : 0;
        msg += `💎 *${a.asset}* (${percent}%)\n`;
        if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
        msg += `  القيمة: $${a.value.toFixed(2)}\n`;
        msg += `  الكمية: ${a.amount}\n\n`;
    });
    msg += `🕒 *آخر تحديث:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}

function createChartUrl(history) {
    if (history.length < 2) return null;
    const last7Days = history.slice(-7);
    const labels = last7Days.map(h => h.date.slice(5));
    const data = last7Days.map(h => h.total.toFixed(2));
    const chartConfig = {
        type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: 'rgba(75, 192, 192, 0.2)', borderColor: 'rgb(75, 192, 192)', tension: 0.1 }] },
        options: { title: { display: true, text: 'أداء المحفظة آخر 7 أيام' } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
}

async function checkNewTrades() {
    try {
        const path = "/api/v5/trade/orders-history?instType=SPOT&state=filled";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();

        if (json.code !== '0' || !json.data) {
            return console.error("Failed to fetch trade history:", json.msg);
        }

        const lastTrades = loadLastTrades();
        let newTradesFound = false;

        for (const trade of json.data.reverse()) {
            if (!lastTrades[trade.ordId]) {
                const instId = trade.instId;
                const ccy = instId.split('-')[0];
                let side = trade.side === 'buy' ? 'شراء 🟢' : 'بيع 🔴';
                const avgPx = parseFloat(trade.avgPx);
                const sz = parseFloat(trade.sz);
                const fee = parseFloat(trade.fee);

                // --- Improvement to check for Full/Partial Sell ---
                if (trade.side === 'sell') {
                    const balancePath = `/api/v5/account/balance?ccy=${ccy}`;
                    const balanceRes = await fetch(`${API_BASE_URL}${balancePath}`, { headers: getHeaders("GET", balancePath) });
                    const balanceJson = await balanceRes.json();
                    let currentBalance = 0;
                    if (balanceJson.code === '0' && balanceJson.data[0]?.details[0]) {
                        currentBalance = parseFloat(balanceJson.data[0].details[0].availBal);
                    }
                    if (currentBalance < 0.0001) { // Use a small threshold for dust
                        side = 'بيع كلي 🔴';
                    } else {
                        side = 'بيع جزئي 🔴';
                    }
                }
                // --- End of Improvement ---

                let message = `🔔 *صفقة جديدة!* 🔔\n\n`;
                message += `*${side}* - *${instId}*\n\n`;
                message += `- *الكمية:* ${sz}\n`;
                message += `- *متوسط السعر:* $${avgPx.toFixed(5)}\n`;
                message += `- *قيمة الصفقة:* $${(sz * avgPx).toFixed(2)}\n`;
                message += `- *الرسوم:* $${fee.toFixed(4)} (${trade.feeCcy})\n`;
                if (parseFloat(trade.pnl) !== 0) {
                    message += `- *الربح/الخسارة المحقق:* $${parseFloat(trade.pnl).toFixed(2)}\n`;
                }

                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                lastTrades[trade.ordId] = true;
                newTradesFound = true;
            }
        }

        if (newTradesFound) {
            saveLastTrades(lastTrades);
        }

    } catch (error) {
        console.error("Error in checkNewTrades:", error);
    }
}

async function checkAlerts() {
    const alerts = loadAlerts();
    if (alerts.length === 0) return;

    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') {
            return console.error("Failed to fetch tickers for alerts:", tickersJson.msg);
        }

        const prices = {};
        tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));

        const remainingAlerts = [];
        let alertsTriggered = false;

        for (const alert of alerts) {
            if (!alert.active || !prices[alert.instId]) {
                remainingAlerts.push(alert);
                continue;
            }

            const currentPrice = prices[alert.instId];
            let triggered = false;

            if (alert.condition === '>' && currentPrice > alert.price) triggered = true;
            else if (alert.condition === '<' && currentPrice < alert.price) triggered = true;

            if (triggered) {
                const message = `🚨 *تنبيه سعر!* 🚨\n\n- العملة: *${alert.instId}*\n- الشرط: تحقق (${alert.condition} ${alert.price})\n- السعر الحالي: *${currentPrice}*`;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                alertsTriggered = true;
            } else {
                remainingAlerts.push(alert);
            }
        }

        if (alertsTriggered) {
            saveAlerts(remainingAlerts);
        }

    } catch (error) {
        console.error("Error in checkAlerts:", error);
    }
}

async function runDailyJobs() {
    const settings = loadSettings();
    if (!settings.dailySummary) return;
    const { total, error } = await getPortfolio();
    if (error) return console.error("Daily Summary Error:", error);
    const history = loadHistory();
    const date = new Date().toISOString().slice(0, 10);
    if (history.length && history[history.length - 1].date === date) return;
    history.push({ date, total });
    if (history.length > 30) history.shift();
    saveHistory(history);
    console.log(`[✅ Daily Summary]: ${date} - $${total.toFixed(2)}`);
}

// === Bot UI and Command Handlers ===

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();

bot.command("start", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*\n\n- أهلاً بك! الواجهة الرئيسية للوصول السريع، والإدارة الكاملة من قائمة /settings.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    await ctx.reply("⚙️ *لوحة التحكم والإعدادات*:", { parse_mode: "Markdown", reply_markup: settingsKeyboard });
});

// === Inline Keyboard Callbacks ===
bot.callbackQuery("set_capital", async (ctx) => { waitingState = 'set_capital'; await ctx.answerCallbackQuery(); await ctx.reply("💰 أرسل المبلغ الجديد لرأس المال."); });

bot.callbackQuery("view_alerts", async (ctx) => {
    await ctx.answerCallbackQuery();
    const alerts = loadAlerts();
    if (alerts.length === 0) return ctx.reply("ℹ️ لا توجد تنبيهات نشطة حاليًا.");
    let msg = "🔔 *قائمة التنبيهات النشطة:*\n\n";
    alerts.forEach(a => { msg += `- *ID:* \`${a.id}\`\n  العملة: ${a.instId}\n  الشرط: ${a.condition === '>' ? 'أعلى من' : 'أقل من'} ${a.price}\n\n`; });
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.callbackQuery("delete_alert", async (ctx) => { waitingState = 'delete_alert'; await ctx.answerCallbackQuery(); await ctx.reply("🗑️ أرسل ID التنبيه الذي تريد حذفه."); });

bot.callbackQuery("toggle_summary", async (ctx) => {
    const settings = loadSettings();
    settings.dailySummary = !settings.dailySummary;
    saveSettings(settings);
    await ctx.answerCallbackQuery({ text: `تم ${settings.dailySummary ? 'تفعيل' : 'إيقاف'} الملخص اليومي ✅` });
    const updatedKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    await ctx.editMessageReplyMarkup({ reply_markup: updatedKeyboard });
});

bot.callbackQuery("delete_all_data", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("⚠️ هل أنت متأكد من حذف كل البيانات؟ هذا الإجراء لا يمكن التراجع عنه.\n\nأرسل كلمة `تأكيد` خلال 30 ثانية.", { parse_mode: "Markdown" });
    waitingState = 'confirm_delete_all';
    setTimeout(() => { if (waitingState === 'confirm_delete_all') waitingState = null; }, 30000);
});

// === Main Text Message Handler ===
bot.on("message:text", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const text = ctx.message.text.trim();

    // --- 1. Handle Main Keyboard Buttons ---
    switch (text) {
        case "📊 عرض المحفظة":
            await ctx.reply('⏳ لحظات... جار تحديث بيانات المحفظة.');
            const { assets, total, error } = await getPortfolio();
            if (error) return await ctx.reply(`❌ ${error}`);
            const capital = loadCapital();
            const msg = formatPortfolioMsg(assets, total, capital);
            return await ctx.reply(msg, { parse_mode: "Markdown" });

        case "📈 أداء المحفظة":
            const history = loadHistory();
            if (history.length < 2) return await ctx.reply("ℹ️ لا توجد بيانات كافية. يرجى تفعيل الملخص اليومي والانتظار.");
            const chartUrl = createChartUrl(history);
            const latest = history[history.length - 1]?.total || 0;
            const previous = history[history.length - 2]?.total || 0;
            const diff = latest - previous;
            const percent = previous > 0 ? (diff / previous) * 100 : 0;
            const summary = `*تغير آخر يوم:*\n${diff >= 0 ? '🟢' : '🔴'} $${diff.toFixed(2)} (${percent.toFixed(2)}%)`;
            return await ctx.replyWithPhoto(chartUrl, { caption: `أداء محفظتك خلال الأيام السبعة الماضية.\n\n${summary}`, parse_mode: "Markdown" });

        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            return await ctx.reply("ℹ️ أرسل رمز العملة (مثال: BTC-USDT).");

        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            return await ctx.reply("📝 *أرسل تفاصيل التنبيه:*\n`SYMBOL > PRICE` أو `SYMBOL < PRICE`", { parse_mode: "Markdown" });

        case "👁️ مراقبة الصفقات":
            if (!tradeMonitoringInterval) {
                await checkNewTrades();
                tradeMonitoringInterval = setInterval(checkNewTrades, 60000);
                return await ctx.reply("✅ تم تشغيل مراقبة الصفقات الجديدة.");
            } else {
                clearInterval(tradeMonitoringInterval);
                tradeMonitoringInterval = null;
                return await ctx.reply("🛑 تم إيقاف مراقبة الصفقات الجديدة.");
            }

        case "⚙️ الإعدادات":
            return bot.api.sendMessage(ctx.from.id, "/settings");
    }

    // --- 2. Handle Inputs Based on waitingState ---
    if (waitingState) {
        const state = waitingState;
        waitingState = null; // Reset state immediately to prevent race conditions
        switch (state) {
            case 'set_capital':
                const amount = parseFloat(text);
                if (!isNaN(amount) && amount >= 0) {
                    saveCapital(amount); await ctx.reply(`✅ تم تحديث رأس المال إلى: $${amount.toFixed(2)}`);
                } else { await ctx.reply("❌ مبلغ غير صالح."); }
                break;
            case 'coin_info':
                const { error, ...details } = await getInstrumentDetails(text);
                if (error) { await ctx.reply(`❌ ${error}`); }
                else {
                    let msg = `*ℹ️ معلومات ${text.toUpperCase()}*\n\n`;
                    msg += `- *السعر الحالي:* \`$${details.price}\`\n`;
                    msg += `- *أعلى سعر (24س):* \`$${details.high24h}\`\n`;
                    msg += `- *أدنى سعر (24س):* \`$${details.low24h}\`\n`;
                    msg += `- *حجم التداول (24س):* \`${details.vol24h.toFixed(2)} ${text.split('-')[0]}\``;
                    await ctx.reply(msg, { parse_mode: "Markdown" });
                }
                break;
            case 'set_alert':
                const [instId, condition, priceStr] = text.split(" ");
                const price = parseFloat(priceStr);
                if (!instId || !condition || !priceStr || !['>', '<'].includes(condition) || isNaN(price)) {
                    await ctx.reply("❌ صيغة غير صحيحة. يرجى استخدام الصيغة: `SYMBOL > PRICE`");
                } else {
                    const alerts = loadAlerts();
                    const formattedInstId = instId.includes('-') ? instId.toUpperCase() : `${instId.toUpperCase()}-USDT`;
                    const newAlert = { id: crypto.randomUUID().slice(0, 8), instId: formattedInstId, condition, price, active: true };
                    alerts.push(newAlert);
                    saveAlerts(alerts);
                    await ctx.reply(`✅ تم ضبط التنبيه بنجاح!\nسأقوم بإعلامك عندما يصبح سعر ${newAlert.instId} ${condition} ${newAlert.price}.`);
                }
                break;
            case 'delete_alert':
                const alertId = text;
                let alerts = loadAlerts();
                const initialLength = alerts.length;
                alerts = alerts.filter(a => a.id !== alertId);
                if (alerts.length === initialLength) {
                    await ctx.reply("❌ لم يتم العثور على تنبيه بهذا الـ ID.");
                } else {
                    saveAlerts(alerts);
                    await ctx.reply(`✅ تم حذف التنبيه \`${alertId}\` بنجاح.`);
                }
                break;
            case 'confirm_delete_all':
                if (text.toLowerCase() === 'تأكيد') {
                    saveCapital(0);
                    saveAlerts([]);
                    saveLastTrades({});
                    saveHistory([]);
                    saveSettings({ dailySummary: false });
                    await ctx.reply("✅ تم حذف جميع البيانات بنجاح.");
                } else {
