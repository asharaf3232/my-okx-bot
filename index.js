// =================================================================
// OKX Advanced Analytics Bot - v8 (Final Reviewed Version)
// =================================================================
// هذا الإصدار هو النسخة النهائية والمراجعة. تم التأكد من خلوه
// من الأخطاء واحتوائه على جميع الميزات المطلوبة.
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
const SETTINGS_FILE = `${DATA_DIR}/data_settings.json`;

// --- متغيرات الحالة والمؤشرات ---
let waitingState = null;
let balanceMonitoringInterval = null;
let previousBalanceState = {};
let alertsCheckInterval = null;
let dailyJobsInterval = null;

// === دوال مساعدة وإدارة الملفات ===

function readJsonFile(filePath, defaultValue) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return defaultValue;
    } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; }
}

function writeJsonFile(filePath, data) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) { console.error(`Error writing to ${filePath}:`, error); }
}

const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

// === دوال API ===

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

// === دوال العرض والمساعدة ===

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
        msg += `  الكمية: ${a.amount.toFixed(6)}\n\n`;
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

// === دوال منطق البوت والمهام المجدولة ===

async function getPortfolio() {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
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
                if (value >= 1) { // فلترة الأصول التي تقل قيمتها عن 1 دولار
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

async function getBalanceForComparison() {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0') {
            console.error("Error fetching balance for comparison:", json.msg);
            return null;
        }
        const balanceMap = {};
        json.data[0]?.details?.forEach(asset => {
            const totalBalance = parseFloat(asset.eq);
            if (totalBalance > 1e-9) {
                balanceMap[asset.ccy] = totalBalance;
            }
        });
        return balanceMap;
    } catch (error) {
        console.error("Exception in getBalanceForComparison:", error);
        return null;
    }
}

async function monitorBalanceChanges() {
    const currentBalance = await getBalanceForComparison();
    if (!currentBalance) return;

    if (Object.keys(previousBalanceState).length === 0) {
        previousBalanceState = currentBalance;
        console.log("Initial balance state captured. Monitoring will start on the next cycle.");
        return;
    }

    const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
    const notifications = [];

    allAssets.forEach(asset => {
        const prevAmount = previousBalanceState[asset] || 0;
        const currAmount = currentBalance[asset] || 0;
        const difference = currAmount - prevAmount;
        if (Math.abs(difference) < 1e-9) return;
        if (difference > 0) {
            notifications.push(`🟢 *شراء جديد أو إيداع* \nالكمية: \`${difference.toFixed(8)}\` *${asset}*`);
        } else {
            notifications.push(`🔴 *بيع أو سحب*\nالكمية: \`${Math.abs(difference).toFixed(8)}\` *${asset}*`);
        }
    });

    if (notifications.length > 0) {
        const message = "🔔 *تنبيه بتغير في الرصيد*\n\n" + notifications.join("\n\n");
        await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
    }
    previousBalanceState = currentBalance;
}

async function checkPriceAlerts() {
    const alerts = loadAlerts();
    if (alerts.length === 0) return;
    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') return console.error("Failed to fetch tickers for alerts:", tickersJson.msg);
        
        const prices = {};
        tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        
        const remainingAlerts = [];
        let alertsTriggered = false;

        for (const alert of alerts) {
            const currentPrice = prices[alert.instId];
            if (currentPrice === undefined) {
                remainingAlerts.push(alert);
                continue;
            }
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
        console.error("Error in checkPriceAlerts:", error);
    }
}

async function runDailyJobs() {
    const settings = loadSettings();
    if (!settings.dailySummary) return;
    const { total, error } = await getPortfolio();
    if (error) return console.error("Daily Summary Error:", error);
    const history = loadHistory();
    const date = new Date().toISOString().slice(0, 10);
    if (history.length > 0 && history[history.length - 1].date === date) {
        history[history.length - 1].total = total;
    } else {
        history.push({ date, total });
    }
    if (history.length > 30) history.shift();
    saveHistory(history);
    console.log(`[✅ Daily Summary]: ${date} - $${total.toFixed(2)}`);
}

// === واجهة البوت ومعالجات الأوامر ===

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    await ctx.reply("⚙️ *لوحة التحكم والإعدادات*:", { parse_mode: "Markdown", reply_markup: settingsKeyboard });
}

bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
    }
});

bot.command("start", async (ctx) => {
    await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*\n\n- أهلاً بك! الواجهة الرئيسية للوصول السريع، والإدارة الكاملة من قائمة /settings.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));

bot.command("pnl", async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply("❌ *صيغة غير صحيحة.*\n\n" + "يرجى استخدام الصيغة التالية:\n" + "`/pnl <سعر الشراء> <سعر البيع> <الكمية>`\n\n" + "*مثال:*\n`/pnl 100 120 0.5`", { parse_mode: "Markdown" });
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم التي أدخلتها هي أرقام موجبة وصالحة.");
    }
    const totalInvestment = buyPrice * quantity;
    const totalSaleValue = sellPrice * quantity;
    const profitOrLoss = totalSaleValue - totalInvestment;
    const pnlPercentage = (profitOrLoss / totalInvestment) * 100;
    const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻";
    const responseMessage = `*📊 نتيجة الحساب:*\n\n- *إجمالي تكلفة الشراء:* \`$${totalInvestment.toLocaleString()}\`\n- *إجمالي قيمة البيع:* \`$${totalSaleValue.toLocaleString()}\`\n\n- *قيمة الربح/الخسارة:* \`$${profitOrLoss.toLocaleString()}\`\n- *نسبة الربح/الخسارة:* \`${pnlPercentage.toFixed(2)}%\`\n\n*النتيجة النهائية: ${resultStatus}*`;
    await ctx.reply(responseMessage, { parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    switch (data) {
        case "set_capital":
            waitingState = 'set_capital';
            await ctx.reply("💰 أرسل المبلغ الجديد لرأس المال.");
            break;
        case "view_alerts":
            const alerts = loadAlerts();
            if (alerts.length === 0) return ctx.reply("ℹ️ لا توجد تنبيهات نشطة حاليًا.");
            let msg = "🔔 *قائمة التنبيهات النشطة:*\n\n";
            alerts.forEach(a => { msg += `- *ID:* \`${a.id}\`\n  العملة: ${a.instId}\n  الشرط: ${a.condition === '>' ? 'أعلى من' : 'أقل من'} ${a.price}\n\n`; });
            await ctx.reply(msg, { parse_mode: "Markdown" });
            break;
        case "delete_alert":
            waitingState = 'delete_alert';
            await ctx.reply("🗑️ أرسل ID التنبيه الذي تريد حذفه.");
            break;
        case "toggle_summary":
            const settings = loadSettings();
            settings.dailySummary = !settings.dailySummary;
            saveSettings(settings);
            await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard()
                .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
                .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
                .text("🔥 حذف كل البيانات 🔥", "delete_all_data") });
            break;
        case "delete_all_data":
            waitingState = 'confirm_delete_all';
            await ctx.reply("⚠️ هل أنت متأكد من حذف كل البيانات؟ هذا الإجراء لا يمكن التراجع عنه.\n\nأرسل كلمة `تأكيد` خلال 30 ثانية.", { parse_mode: "Markdown" });
            setTimeout(() => { if (waitingState === 'confirm_delete_all') waitingState = null; }, 30000);
            break;
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            case 'set_capital':
                const amount = parseFloat(text);
                if (!isNaN(amount) && amount >= 0) {
                    saveCapital(amount); await ctx.reply(`✅ تم تحديث رأس المال إلى: $${amount.toFixed(2)}`);
                } else { await ctx.reply("❌ مبلغ غير صالح."); }
                return;
            case 'coin_info':
                const { error, ...details } = await getInstrumentDetails(text);
                if (error) { await ctx.reply(`❌ ${error}`); }
                else {
                    let msg = `*ℹ️ معلومات ${text.toUpperCase()}*\n\n- *السعر الحالي:* \`$${details.price}\`\n- *أعلى سعر (24س):* \`$${details.high24h}\`\n- *أدنى سعر (24س):* \`$${details.low24h}\`\n- *حجم التداول (24س):* \`${details.vol24h.toFixed(2)} ${text.split('-')[0]}\``;
                    await ctx.reply(msg, { parse_mode: "Markdown" });
                }
                return;
            case 'set_alert':
                const parts = text.trim().split(/\s+/);
                if (parts.length !== 3) return await ctx.reply("❌ صيغة غير صحيحة. استخدم: `SYMBOL > PRICE`");
                const [instId, condition, priceStr] = parts;
                const price = parseFloat(priceStr);
                if (!['>', '<'].includes(condition) || isNaN(price)) return await ctx.reply("❌ صيغة غير صحيحة. الشرط يجب أن يكون `>` أو `<` والسعر يجب أن يكون رقماً.");
                const alerts = loadAlerts();
                const newAlert = { id: crypto.randomBytes(4).toString('hex'), instId: instId.toUpperCase(), condition, price };
                alerts.push(newAlert);
                saveAlerts(alerts);
                await ctx.reply(`✅ تم ضبط التنبيه بنجاح!\nID: \`${newAlert.id}\`\nسيتم إعلامك عندما يصبح سعر ${newAlert.instId} ${newAlert.condition === '>' ? 'أعلى من' : 'أقل من'} ${newAlert.price}`);
                return;
            case 'delete_alert':
                const currentAlerts = loadAlerts();
                const filteredAlerts = currentAlerts.filter(a => a.id !== text);
                if (currentAlerts.length === filteredAlerts.length) { await ctx.reply(`❌ لم يتم العثور على تنبيه بالـ ID: \`${text}\``); }
                else { saveAlerts(filteredAlerts); await ctx.reply(`✅ تم حذف التنبيه بالـ ID: \`${text}\` بنجاح.`); }
                return;
            case 'confirm_delete_all':
                if (text.toLowerCase() === 'تأكيد') {
                    if (fs.existsSync(CAPITAL_FILE)) fs.unlinkSync(CAPITAL_FILE);
                    if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE);
                    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
                    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
                    await ctx.reply("🔥 تم حذف جميع البيانات والإعدادات بنجاح.");
                } else { await ctx.reply("🛑 تم إلغاء عملية الحذف."); }
                return;
        }
    }
    switch (text) {
        case "📊 عرض المحفظة":
            await ctx.reply('⏳ لحظات... جار تحديث بيانات المحفظة.');
            const { assets, total, error } = await getPortfolio();
            if (error) return await ctx.reply(`❌ ${error}`);
            const capital = loadCapital();
            const portfolioMsg = formatPortfolioMsg(assets, total, capital);
            await ctx.reply(portfolioMsg, { parse_mode: "Markdown" });
            break;
        case "📈 أداء المحفظة":
            const history = loadHistory();
            if (history.length < 2) return await ctx.reply("ℹ️ لا توجد بيانات كافية. يرجى تفعيل الملخص اليومي والانتظار ليوم واحد على الأقل.");
            const chartUrl = createChartUrl(history);
            if (!chartUrl) return await ctx.reply("ℹ️ لا توجد بيانات كافية لرسم المخطط.");
            const latest = history[history.length - 1]?.total || 0;
            const previous = history.length > 1 ? history[history.length - 2]?.total : latest;
            const diff = latest - previous;
            const percent = previous > 0 ? (diff / previous) * 100 : 0;
            const summary = `*تغير آخر يوم:*\n${diff >= 0 ? '🟢' : '🔴'} $${diff.toFixed(2)} (${percent.toFixed(2)}%)`;
            await ctx.replyWithPhoto(chartUrl, { caption: `أداء محفظتك خلال الأيام السبعة الماضية.\n\n${summary}`, parse_mode: "Markdown" });
            break;
        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            await ctx.reply("ℹ️ أرسل رمز العملة (مثال: BTC-USDT).");
            break;
        case "🧮 حاسبة الربح والخسارة":
            await ctx.reply("لحساب الربح أو الخسارة، استخدم الأمر `/pnl` بالشكل التالي:\n\n" + "`/pnl <سعر الشراء> <سعر البيع> <الكمية>`\n\n" + "*مثال:*\n`/pnl 100 120 0.5`", { parse_mode: "Markdown" });
            break;
        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            await ctx.reply("📝 *أرسل تفاصيل التنبيه:*\n`SYMBOL > PRICE` أو `SYMBOL < PRICE`", { parse_mode: "Markdown" });
            break;
        case "👁️ مراقبة الصفقات":
            if (!balanceMonitoringInterval) {
                await ctx.reply("⏳ جارٍ إعداد المراقبة... سيتم أولاً جلب الرصيد الحالي كنقطة بداية.");
                previousBalanceState = await getBalanceForComparison();
                if (previousBalanceState === null) return await ctx.reply("❌ فشل في جلب الرصيد الأولي. لا يمكن بدء المراقبة.");
                balanceMonitoringInterval = setInterval(monitorBalanceChanges, 20000);
                await ctx.reply("✅ تم تشغيل مراقبة الصفقات. سيتم إعلامك بأي تغيير.");
            } else {
                clearInterval(balanceMonitoringInterval);
                balanceMonitoringInterval = null;
                previousBalanceState = {};
                await ctx.reply("🛑 تم إيقاف مراقبة الصفقات.");
            }
            break;
        case "⚙️ الإعدادات":
            await sendSettingsMenu(ctx);
            break;
    }
});

// === بدء تشغيل البوت ===
async function startBot() {
    try {
        console.log("Bot is starting with smart balance monitoring...");
        alertsCheckInterval = setInterval(checkPriceAlerts, 60000);
        dailyJobsInterval = setInterval(runDailyJobs, 60 * 60 * 1000);
        
        // 1. Webhook (للاستضافة على سيرفر)
        // app.use(express.json());
        // app.use(webhookCallback(bot, "express"));
        // app.listen(PORT, () => console.log(`Bot server listening on port ${PORT}`));

        // 2. Long Polling (للتشغيل المحلي على جهازك)
        await bot.start();

        console.log("Bot started successfully.");
    } catch (error) {
        console.error("FATAL: Failed to start the bot.", error);
    }
}

startBot();

