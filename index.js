// OKX Portfolio Bot (Stable - All Features - Egypt TZ - Capital Save - Safe Monitoring)
const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const fs = require("fs");
require("dotenv").config();

const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";
const CAPITAL_FILE = "capital.json";
const MONITOR_FILE = "monitor.json";

// Egypt Time
function getEgyptTime() {
    return new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });
}

// Capital save/load
function saveCapital(amount) {
    fs.writeFileSync(CAPITAL_FILE, JSON.stringify({ capital: amount }));
}
function loadCapital() {
    try {
        const data = JSON.parse(fs.readFileSync(CAPITAL_FILE));
        return data.capital;
    } catch {
        return 0;
    }
}

// Monitor save/load
function saveMonitorState(state) {
    fs.writeFileSync(MONITOR_FILE, JSON.stringify({ monitor: state }));
}
function loadMonitorState() {
    try {
        const data = JSON.parse(fs.readFileSync(MONITOR_FILE));
        return data.monitor;
    } catch {
        return false;
    }
}

// OKX Headers
function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + body;
    const crypto = require("crypto");
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY)
        .update(prehash)
        .digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

// Get Portfolio
async function getPortfolio() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, {
            headers: getHeaders("GET", "/api/v5/account/balance")
        });
        const json = await res.json();

        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        const prices = {};
        tickersJson.data.forEach(t => {
            prices[t.instId] = parseFloat(t.last);
        });

        let assets = [];
        let total = 0;
        json.data[0].details.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
                const value = amount * price;
                if (value >= 1) {
                    assets.push({
                        asset: asset.ccy,
                        price,
                        value,
                        amount
                    });
                    total += value;
                }
            }
        });

        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error(e);
        return { assets: [], total: 0 };
    }
}

// Format message
function formatPortfolioMsg(assets, total, capital) {
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;

    let msg = `📊 *ملخص المحفظة* 📊\n\n`;
    msg += `💰 *القيمة الحالية:* $${total.toFixed(2)}\n`;
    msg += `💼 *رأس المال الأساسي:* $${capital.toFixed(2)}\n`;
    msg += `📈 *PnL:* ${pnl >= 0 ? '🟢' : '🔴'} ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n`;
    msg += `------------------------------------\n`;

    assets.forEach(a => {
        msg += `💎 *${a.asset}*\n`;
        if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
        msg += `  القيمة: $${a.value.toFixed(2)}\n`;
        msg += `  الكمية: ${a.amount}\n\n`;
    });

    msg += `🕒 *آخر تحديث:* ${getEgyptTime()}`;
    return msg;
}

// Auto monitoring
setInterval(async () => {
    if (loadMonitorState()) {
        const { assets, total } = await getPortfolio();
        const capital = loadCapital();
        const msg = formatPortfolioMsg(assets, total, capital);
        await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
    }
}, 5 * 60 * 1000);

// Commands
bot.command("start", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const keyboard = new InlineKeyboard()
        .text("📊 عرض المحفظة", "refresh")
        .row()
        .text("✅ تشغيل المراقبة", "startmonitor")
        .text("⛔ إيقاف المراقبة", "stopmonitor")
        .row()
        .text("⚙️ تعيين رأس المال", "setcapital");
    await ctx.reply("🤖 *أهلاً بك في بوت مراقبة محفظة OKX*\n\n- اختر من الأزرار أدناه:", {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
});

bot.callbackQuery("refresh", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.answerCallbackQuery();
    const { assets, total } = await getPortfolio();
    const capital = loadCapital();
    const msg = formatPortfolioMsg(assets, total, capital);
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.callbackQuery("startmonitor", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (loadMonitorState()) {
        await ctx.answerCallbackQuery({ text: "⚠️ المراقبة مفعلة بالفعل." });
    } else {
        saveMonitorState(true);
        await ctx.answerCallbackQuery();
        await ctx.reply("✅ تم تشغيل المراقبة التلقائية (كل 5 دقائق).");
    }
});

bot.callbackQuery("stopmonitor", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (!loadMonitorState()) {
        await ctx.answerCallbackQuery({ text: "⚠️ المراقبة متوقفة بالفعل." });
    } else {
        saveMonitorState(false);
        await ctx.answerCallbackQuery();
        await ctx.reply("⛔ تم إيقاف المراقبة التلقائية.");
    }
});

bot.callbackQuery("setcapital", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ أرسل الآن المبلغ المراد تعيينه كرأس مال مثل:\n5000");
    bot.on("message:text", async msgCtx => {
        if (msgCtx.from.id !== AUTHORIZED_USER_ID) return;
        const amount = parseFloat(msgCtx.message.text);
        if (!isNaN(amount) && amount > 0) {
            saveCapital(amount);
            await msgCtx.reply(`✅ تم تعيين رأس المال إلى: $${amount.toFixed(2)}`);
        } else {
            await msgCtx.reply("❌ المبلغ غير صالح، حاول مرة أخرى.");
        }
    });
});

// Express
app.use(express.json());
app.use(webhookCallback(bot, "express"));
app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    const domain = process.env.RAILWAY_STATIC_URL;
    if (domain) {
        await bot.api.setWebhook(`https://${domain}/${bot.token}`);
        console.log(`✅ Webhook set to: https://${domain}/${bot.token}`);
    }
});
