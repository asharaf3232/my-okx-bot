// =================================================================
// OKX Advanced Analytics Bot - v84 (Virtual Trades Feature)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
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

async function saveVirtualTrade(tradeData) {
    try {
        await getCollection("virtualTrades").insertOne(tradeData);
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

async function updateVirtualTradeStatus(tradeId, status) {
    try {
        await getCollection("virtualTrades").updateOne({ _id: tradeId }, { $set: { status: status } });
    } catch (e) {
        console.error(`Error updating virtual trade ${tradeId}:`, e);
    }
}

// ... (Existing helper functions remain the same)
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

function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals);
    return number.toFixed(decimals);
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
                prices[t.instId] = { price: parseFloat(t.last) };
            }
        });
        return prices;
    } catch (error) {
        console.error("Exception in getMarketPrices:", error.message);
        return null;
    }
}

// ... (Other API functions like getPortfolio, getInstrumentDetails etc. remain)
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
                const value = amount * priceData.price;
                total += value;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h });
                }
            }
        });
        
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
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
// (Most functions remain the same)
// =================================================================

async function formatPortfolioMsg(assets, total, capital) {
    // This function remains unchanged from v83
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
    const pnlSign = pnl >= 0 ? '+' : '';
    const usdtValue = (assets.find(a => a.asset === 'USDT') || { value: 0 }).value;
    const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;
    const liquidityText = ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(cashPercent, 1)}% / 📈 مستثمر ${formatNumber(100 - cashPercent, 1)}%`;

    let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`;
    msg += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`;
    msg += ` ▫️ *إجمالي الربح غير المحقق:* ${pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
    msg += dailyPnlText + liquidityText + `\n━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`;

    assets.forEach((a, index) => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `*USDT* (الرصيد النقدي) 💵\n*القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)`;
        } else {
            const change24hPercent = (a.change24h || 0) * 100;
            const changeEmoji = change24hPercent >= 0 ? '🟢⬆️' : '🔴⬇️';
            const changeSign = change24hPercent >= 0 ? '+' : '';
            msg += `╭─ *${a.asset}/USDT*\n`;
            msg += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`;
            msg += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`;
            msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${formatNumber(change24hPercent)}%\`\n`;
            const position = positions[a.asset];
            if (position?.avgBuyPrice > 0) {
                const totalCost = position.avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0;
                msg += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`;
                msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnl >= 0 ? '🟢' : '🔴'} \`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnl)}\` (\`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnlPercent)}%\`)`;
            } else {
                msg += `╰─ *متوسط الشراء:* \`غير مسجل\``;
            }
        }
        if (index < assets.length - 1) msg += `\n━━━━━━━━━━━━━━━━━━━━`;
    });
    return msg;
}

// =================================================================
// SECTION 4: BACKGROUND JOBS
// =================================================================

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

        // Check for Take Profit
        if (currentPrice >= trade.targetPrice) {
            pnl = (trade.targetPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = 'completed';
            const profitPercent = (pnl / trade.virtualAmount) * 100;
            const msg = `🎯 *الهدف تحقق (توصية افتراضية)!* ✅\n\n` +
                        `*العملة:* \`${trade.instId}\`\n` +
                        `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                        `*سعر الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n\n` +
                        `💰 *الربح المحقق:* \`+$${formatNumber(pnl)}\` (\`+${formatNumber(profitPercent)}%\`)`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        }
        // Check for Stop Loss
        else if (currentPrice <= trade.stopLossPrice) {
            pnl = (trade.stopLossPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = 'stopped';
            const lossPercent = (pnl / trade.virtualAmount) * 100;
            const msg = `🛑 *تم تفعيل وقف الخسارة (توصية افتراضية)!* 🔻\n\n` +
                        `*العملة:* \`${trade.instId}\`\n` +
                        `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                        `*سعر الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n\n` +
                        `💸 *الخسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(lossPercent)}%\`)`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        }

        if (finalStatus) {
            await updateVirtualTradeStatus(trade._id, finalStatus);
        }
    }
}

// ... (Other background jobs like monitorBalanceChanges, checkPriceAlerts, etc. remain)
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


// =================================================================
// SECTION 5: BOT SETUP, KEYBOARDS, AND HANDLERS
// =================================================================

// MODIFIED: Main Keyboard
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("🚀 تحليل السوق").text("💡 توصية افتراضية").row() // Replaced "أفضل 5 أصول"
    .text("⚡ إحصائيات سريعة").text("ℹ️ معلومات عملة").row()
    .text("🔔 ضبط تنبيه").text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

// NEW: Virtual Trade Keyboard
const virtualTradeKeyboard = new InlineKeyboard()
    .text("➕ إضافة توصية جديدة", "add_virtual_trade").row()
    .text("📈 متابعة التوصيات الحية", "track_virtual_trades");

bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) await next();
    else console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
});

bot.command("start", (ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت OKX التحليلي المتكامل، مساعدك الذكي لإدارة وتحليل محفظتك الاستثمارية.*\n\n` +
        `*الإصدار: v84 - Virtual Trades*\n\n` +
        `أنا هنا لمساعدتك على:\n` +
        `- 📊 تتبع أداء محفظتك لحظة بلحظة.\n` +
        `- 💡 متابعة توصيات افتراضية وتنبيهك بالنتائج.\n` +
        `- 🔔 ضبط تنبيهات ذكية للأسعار.\n\n` +
        `*اضغط على الأزرار أدناه للبدء!*`;
    ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => {
    // This now uses sendSettingsMenu function for consistency
    const settings = await loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("💼 عرض المراكز المفتوحة", "view_positions").row()
        .text("🗑️ حذف تنبيه سعر", "delete_alert").row()
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary")
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
        .text("🔥 حذف جميع البيانات 🔥", "delete_all_data");
    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
});


bot.command("pnl", async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(`❌ *صيغة غير صحيحة.*\n*مثال:* \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``, { parse_mode: "Markdown" });
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة.");
    }
    const investment = buyPrice * quantity;
    const saleValue = sellPrice * quantity;
    const pnl = saleValue - investment;
    const pnlPercent = (investment > 0) ? (pnl / investment) * 100 : 0;
    const status = pnl >= 0 ? "ربح ✅" : "خسارة 🔻";
    const sign = pnl >= 0 ? '+' : '';
    const msg = `🧮 *نتيجة حساب الربح والخسارة*\n\n` +
                `*صافي الربح/الخسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n` +
                `**الحالة النهائية: ${status}**`;
    await ctx.reply(msg, { parse_mode: "Markdown" });
});


bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;

    // ... (Handler for "chart_" remains the same)
    if (data.startsWith("chart_")) {
        const period = data.split('_')[1];
        await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء...");
        let history, periodLabel, periodData;
        if (period === '24h') { history = await loadHourlyHistory(); periodLabel = "آخر 24 ساعة"; periodData = history.slice(-24).map(h => ({label: new Date(h.label).getHours() + ':00', total: h.total })); }
        else if (period === '7d') { history = await loadHistory(); periodLabel = "آخر 7 أيام"; periodData = history.slice(-7).map(h => ({ label: h.date.slice(5), total: h.total })); }
        else if (period === '30d') { history = await loadHistory(); periodLabel = "آخر 30 يومًا"; periodData = history.slice(-30).map(h => ({ label: h.date.slice(5), total: h.total })); }
        if (!periodData || periodData.length < 2) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); return; }
        const stats = calculatePerformanceStats(periodData);
        if (!stats) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); return; }
        const chartUrl = createChartUrl(periodData, periodLabel, stats.pnl);
        const pnlSign = stats.pnl >= 0 ? '+' : '';
        const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` +
                      `📈 *النتيجة:* ${stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` +
                      `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n` +
                      `📝 *ملخص إحصائيات الفترة:*\n` +
                      ` ▫️ *أعلى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.maxValue)}\`\n` +
                      ` ▫️ *أدنى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.minValue)}\`\n` +
                      ` ▫️ *متوسط قيمة المحفظة:* \`$${formatNumber(stats.avgValue)}\`\n\n` +
                      `*التقرير تم إنشاؤه في: ${new Date().toLocaleDateString("en-GB").replace(/\//g, '.')}*`;
        try { await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" }); await ctx.deleteMessage(); } 
        catch (e) { console.error("Chart send failed:", e); await ctx.editMessageText("❌ فشل إنشاء الرسم البياني."); }
        return;
    }
    
    switch(data) {
        case "add_virtual_trade":
            waitingState = 'add_virtual_trade';
            await ctx.editMessageText(
                "✍️ *لإضافة توصية افتراضية جديدة، أرسل التفاصيل بالصيغة التالية (كل معلومة في سطر):*\n\n" +
                "`BTC-USDT`\n" +
                "`دخول: 65000`\n" +
                "`هدف: 70000`\n" +
                "`وقف: 62000`\n" +
                "`مبلغ: 1000`\n\n" +
                "*ملاحظة: استخدم النقطة `.` للكسور العشرية.*"
            , { parse_mode: "Markdown" });
            break;

        case "track_virtual_trades":
            await ctx.editMessageText("⏳ جاري جلب حالة التوصيات النشطة...");
            const activeTrades = await getActiveVirtualTrades();
            if (activeTrades.length === 0) {
                await ctx.editMessageText("✅ لا توجد توصيات افتراضية نشطة حاليًا.", { reply_markup: virtualTradeKeyboard });
                return;
            }
            const prices = await getMarketPrices();
            if (!prices) {
                await ctx.editMessageText("❌ فشل جلب الأسعار، لا يمكن متابعة التوصيات.", { reply_markup: virtualTradeKeyboard });
                return;
            }

            let reportMsg = "📈 *متابعة حية للتوصيات النشطة:*\n" + "━━━━━━━━━━━━━━━━━━━━\n";
            for (const trade of activeTrades) {
                const currentPrice = prices[trade.instId]?.price;
                if (!currentPrice) {
                    reportMsg += `*${trade.instId}:* \`لا يمكن جلب السعر الحالي.\`\n`;
                } else {
                    const pnl = (currentPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
                    const pnlPercent = (pnl / trade.virtualAmount) * 100;
                    const emoji = pnl >= 0 ? '🟢' : '🔴';

                    reportMsg += `*${trade.instId}* ${emoji}\n` +
                               ` ▫️ *الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                               ` ▫️ *الحالي:* \`$${formatNumber(currentPrice, 4)}\`\n` +
                               ` ▫️ *ربح/خسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(pnlPercent)}%\`)\n` +
                               ` ▫️ *الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n` +
                               ` ▫️ *الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n`;
                }
                reportMsg += "━━━━━━━━━━━━━━━━━━━━\n";
            }
            await ctx.editMessageText(reportMsg, { parse_mode: "Markdown", reply_markup: virtualTradeKeyboard });
            break;
            
        // ... (Other callback handlers like set_capital, delete_alert, etc. remain)
    }
});


bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            case 'add_virtual_trade':
                try {
                    const lines = text.split('\n');
                    if (lines.length < 5) throw new Error("التنسيق غير صحيح، يجب أن يتكون من 5 أسطر.");

                    const instId = lines[0].trim().toUpperCase();
                    const entryPrice = parseFloat(lines[1].split(':')[1].trim());
                    const targetPrice = parseFloat(lines[2].split(':')[1].trim());
                    const stopLossPrice = parseFloat(lines[3].split(':')[1].trim());
                    const virtualAmount = parseFloat(lines[4].split(':')[1].trim());
                    
                    if (!instId.endsWith('-USDT')) throw new Error("رمز العملة يجب أن ينتهي بـ -USDT.");
                    if (isNaN(entryPrice) || isNaN(targetPrice) || isNaN(stopLossPrice) || isNaN(virtualAmount)) {
                        throw new Error("تأكد من أن أسعار الدخول، الهدف، الوقف، والمبلغ هي أرقام صالحة.");
                    }
                    if (entryPrice <= 0 || targetPrice <= 0 || stopLossPrice <= 0 || virtualAmount <= 0) {
                        throw new Error("جميع القيم يجب أن تكون أكبر من صفر.");
                    }

                    const tradeData = {
                        instId,
                        entryPrice,
                        targetPrice,
                        stopLossPrice,
                        virtualAmount,
                        status: 'active',
                        createdAt: new Date(),
                    };

                    await saveVirtualTrade(tradeData);
                    await ctx.reply(`✅ *تمت إضافة التوصية الافتراضية بنجاح.*\n\nسيتم إعلامك عند تحقيق الهدف أو تفعيل وقف الخسارة.`, { parse_mode: "Markdown" });

                } catch (e) {
                    await ctx.reply(`❌ *خطأ في إضافة التوصية:*\n${e.message}\n\nالرجاء المحاولة مرة أخرى بالتنسيق الصحيح.`);
                }
                return;
            
            // ... (Other waitingState handlers like set_capital, coin_info, etc. remain)
        }
    }
    
    let portfolioData;
    const fetchPortfolioData = async () => {
        if (!portfolioData) {
            const prices = await getMarketPrices();
            if (!prices) return { error: "❌ فشل جلب أسعار السوق." };
            const capital = await loadCapital();
            portfolioData = await getPortfolio(prices);
            portfolioData.capital = capital;
        }
        return portfolioData;
    };

    switch (text) {
        case "📊 عرض المحفظة":
            await ctx.reply("⏳ جاري إعداد التقرير...");
            const { assets, total, capital, error } = await fetchPortfolioData();
            if (error) return await ctx.reply(error);
            const msgPortfolio = await formatPortfolioMsg(assets, total, capital);
            await ctx.reply(msgPortfolio, { parse_mode: "Markdown" });
            break;
        case "🚀 تحليل السوق": // This can be removed or kept based on preference
            await ctx.reply("⏳ جاري تحليل السوق...");
            // market analysis function call
            break;
        case "💡 توصية افتراضية":
            await ctx.reply("اختر الإجراء المطلوب للتوصيات الافتراضية:", { reply_markup: virtualTradeKeyboard });
            break;
        // ... (Other text command handlers remain)
        case "📈 أداء المحفظة":
            const performanceKeyboard = new InlineKeyboard().text("آخر 24 ساعة", "chart_24h").row().text("آخر 7 أيام", "chart_7d").row().text("آخر 30 يومًا", "chart_30d");
            await ctx.reply("اختر الفترة الزمنية لعرض تقرير الأداء:", { reply_markup: performanceKeyboard });
            break;
        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
            break;
        case "⚙️ الإعدادات":
            await bot.command("settings")(ctx); // Call the command handler directly
            break;
        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            await ctx.reply("✍️ *لضبط تنبيه سعر، استخدم الصيغة:*\n`BTC > 50000`", { parse_mode: "Markdown" });
            break;
        case "🧮 حاسبة الربح والخسارة":
            await ctx.reply("✍️ لحساب الربح/الخسارة، استخدم أمر `/pnl` بالصيغة التالية:\n`/pnl <سعر الشراء> <سعر البيع> <الكمية>`", {parse_mode: "Markdown"});
            break;
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
        // setInterval(monitorBalanceChanges, 60_000); // You can keep this or disable
        setInterval(checkPriceAlerts, 30_000);
        setInterval(monitorVirtualTrades, 30_000); // NEW
        setInterval(runHourlyJobs, 3_600_000);
        
        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
        } else {
            await bot.start();
            console.log("Bot started with polling.");
        }
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
    }
}

// Start the bot after all functions are defined
startBot();
