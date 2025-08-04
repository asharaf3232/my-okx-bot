// =================================================================
// OKX Advanced Analytics Bot - v49 (Stable & Complete)
// =================================================================
// This version RE-INTEGRATES the missing "Price Movement Alerts" feature
// and implements DEFENSIVE coding across the entire script to prevent
// all 'toFixed' related crashes, ensuring bot stability.
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

// === Database Functions (Includes Re-added Functions) ===
const getCollection = (collectionName) => getDB().collection("configs");
async function getConfig(id, defaultValue = {}) { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; }
async function saveConfig(id, data) { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); }
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = () => getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = () => getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = () => getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = () => getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
const loadBalanceState = () => getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
const loadAlerts = () => getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
// vvv --- Re-added Features --- vvv
const loadAlertSettings = () => getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = () => getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);
// ^^^ --- End of Re-added Features --- ^^^

// === Helper & API Functions ===
async function sendDebugMessage(message) { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } }
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices:", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) { change24h = (lastPrice - openPrice) / openPrice; } prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h }; }); return prices; } catch (error) { console.error("Exception in getMarketPrices:", error); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` }; let assets = [], total = 0; json.data[0]?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const price = priceData.price; const value = amount * price; if (value >= 1) { assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h }); } total += value; } }); const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > 1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data[0]) return { error: `لم يتم العثور على العملة.` }; const tickerData = tickerJson.data[0]; const candleRes = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId.toUpperCase()}&bar=1D&limit=7`); const candleJson = await candleRes.json(); let weeklyData = { high: 0, low: 0 }; if (candleJson.code === '0' && candleJson.data.length > 0) { const highs = candleJson.data.map(c => parseFloat(c[2])); const lows = candleJson.data.map(c => parseFloat(c[3])); weeklyData.high = Math.max(...highs); weeklyData.low = Math.min(...lows); } return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), open24h: parseFloat(tickerData.open24h), weeklyHigh: weeklyData.high, weeklyLow: weeklyData.low }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getHistoricalHighLow(instId, startDate, endDate) { try { const startMs = new Date(startDate).getTime(); const endMs = endDate.getTime(); const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&before=${startMs}&after=${endMs}`); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) { console.error(`Could not fetch history for ${instId}:`, json.msg); return { high: 0 }; } const highs = json.data.map(c => parseFloat(c[2])); return { high: Math.max(...highs) }; } catch (e) { console.error(`Exception in getHistoricalHighLow for ${instId}:`, e); return { high: 0 }; } }
function createChartUrl(history, periodLabel) { if (history.length < 2) return null; const labels = history.map(h => h.label); const data = history.map(h => h.total.toFixed(2)); const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: 'rgba(75, 192, 192, 0.2)', borderColor: 'rgb(75, 192, 192)', tension: 0.1 }] }, options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue }; }

// === Core Logic & Bot Handlers ===
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(amountChange) * price;
    let retrospectiveReport = null;

    if (amountChange > 0) { // --- Buy Case ---
        if (!position) {
            positions[asset] = { totalAmountBought: amountChange, totalCost: tradeValue, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0, };
        } else {
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
    } else if (amountChange < 0 && position) { // --- Sell Case ---
        const amountSold = Math.abs(amountChange);
        position.realizedValue += tradeValue;
        position.totalAmountSold += amountSold;
        
        if (newTotalAmount < 0.0001) { // Position Closed
            await sendDebugMessage(`Position for ${asset} closed. Generating final report...`);
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = (position.totalCost > 0) ? (finalPnl / position.totalCost) * 100 : 0;
            const avgSellPrice = position.realizedValue / position.totalAmountSold;
            const pnlEmoji = finalPnl >= 0 ? '🟢' : '🔴';
            const { high: peakPrice } = await getHistoricalHighLow(`${asset}-USDT`, position.openDate, new Date());
            let efficiencyText = "";
            if (peakPrice > position.avgBuyPrice) {
                const maxPotentialPnl = (peakPrice - position.avgBuyPrice) * position.totalAmountBought;
                if (maxPotentialPnl > 0 && finalPnl > 0) {
                    const exitEfficiency = (finalPnl / maxPotentialPnl) * 100;
                    efficiencyText = `\n   - *كفاءة الخروج:* لقد حققت **${(exitEfficiency || 0).toFixed(1)}%** من أقصى ربح ممكن.`;
                }
            }
            retrospectiveReport = `✅ **تم إغلاق مركز ${asset}**\n\n` + `*النتيجة النهائية:* ${pnlEmoji} ربح \`${finalPnl >= 0 ? '+' : ''}${(finalPnl || 0).toFixed(2)}\` (\`${finalPnl >= 0 ? '+' : ''}${(finalPnlPercent || 0).toFixed(2)}%\`)\n\n` + `**تحليل الأداء:**\n` + `   - *متوسط الشراء:* \`$${(position.avgBuyPrice || 0).toFixed(4)}\`\n` + `   - *متوسط البيع:* \`$${(avgSellPrice || 0).toFixed(4)}\`\n` + `   - *أعلى سعر خلال الاحتفاظ:* \`$${(peakPrice || 0).toFixed(4)}\`` + efficiencyText;
            delete positions[asset];
        } else { // Partial Sell
            await sendDebugMessage(`Partial sell for ${asset} recorded.`);
        }
    }
    await savePositions(positions);
    return retrospectiveReport;
}

// vvv --- Defensive Coding Applied --- vvv
async function formatPortfolioMsg(assets, total, capital) {
    const history = await loadHistory();
    const positions = await loadPositions();
    let dailyPnlText = "   📈 *الربح/الخسارة (يومي):* `لا توجد بيانات كافية`\n";
    if (history.length > 0) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const previousDayRecord = history.filter(h => h.date !== todayStr).pop();
        if (previousDayRecord && typeof previousDayRecord.total === 'number') {
            const dailyPnl = total - previousDayRecord.total;
            const dailyPnlPercent = previousDayRecord.total > 0 ? (dailyPnl / previousDayRecord.total) * 100 : 0;
            const dailyPnlEmoji = dailyPnl >= 0 ? '🟢' : '🔴';
            const dailyPnlSign = dailyPnl >= 0 ? '+' : '';
            dailyPnlText = `   📈 *الربح/الخسارة (يومي):* ${dailyPnlEmoji} \`${dailyPnlSign}${(dailyPnl || 0).toFixed(2)}\` (\`${dailyPnlSign}${(dailyPnlPercent || 0).toFixed(2)}%\`)\n`;
        }
    }
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
    let pnlSign = pnl >= 0 ? '+' : '';
    const usdtAsset = assets.find(a => a.asset === 'USDT');
    const usdtValue = usdtAsset ? usdtAsset.value : 0;
    const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;
    const investedPercent = 100 - cashPercent;
    const liquidityText = `   - *السيولة:* 💵 الكاش ${(cashPercent || 0).toFixed(1)}% / 📈 المستثمر ${(investedPercent || 0).toFixed(1)}%`;
    let msg = `🧾 *ملخص المحفظة التحليلي*\n\n`;
    msg += `*آخر تحديث للأسعار: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *الأداء العام:*\n`;
    msg += `   💰 *القيمة الحالية:* \`$${(total || 0).toFixed(2)}\`\n`;
    msg += `   💼 *رأس المال:* \`$${(capital || 0).toFixed(2)}\`\n`;
    msg += `   📉 *ربح إجمالي غير محقق:* ${pnlEmoji} \`${pnlSign}${(pnl || 0).toFixed(2)}\` (\`${pnlSign}${(pnlPercent || 0).toFixed(2)}%\`)\n`;
    msg += dailyPnlText;
    msg += liquidityText + `\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 *الأصــــــــول:*\n`;
    assets.forEach((a, index) => {
        let percent = total > 0 ? ((a.value / total) * 100) : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `*USDT* 💵\n`;
            msg += `*الرصيد:* \`$${(a.value || 0).toFixed(2)}\` (\`${(percent || 0).toFixed(2)}%\`)`;
        } else {
            const change24hPercent = (a.change24h || 0) * 100;
            const changeEmoji = change24hPercent >= 0 ? '🟢' : '🔴';
            const changeSign = change24hPercent >= 0 ? '+' : '';
            msg += `╭─ *${a.asset}*\n`;
            msg += `├─ 💰 *القيمة:* \`$${(a.value || 0).toFixed(2)}\` (\`${(percent || 0).toFixed(2)}%\`)\n`;
            msg += `├─ 📈 *السعر الحالي:* \`$${(a.price || 0).toFixed(4)}\`\n`;
            msg += `├─ ⏱️ *تغير (24س):* ${changeEmoji} \`${changeSign}${(change24hPercent || 0).toFixed(2)}%\`\n`;
            const position = positions[a.asset];
            if (position && position.avgBuyPrice > 0) {
                const avgBuyPrice = position.avgBuyPrice;
                const totalCost = avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0;
                const assetPnlEmoji = assetPnl >= 0 ? '🟢' : '🔴';
                const assetPnlSign = assetPnl >= 0 ? '+' : '';
                msg += `├─ 🛒 *متوسط الشراء:* \`$${(avgBuyPrice || 0).toFixed(4)}\`\n`;
                msg += `╰─ 📉 *ربح غير محقق:* ${assetPnlEmoji} \`${assetPnlSign}${(assetPnl || 0).toFixed(2)}\` (\`${assetPnlSign}${(assetPnlPercent || 0).toFixed(2)}%\`)`;
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
// ^^^ End of Defensive Coding ^^^

async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        let previousState = await loadBalanceState();
        let previousBalanceState = previousState.balances || {};
        let previousTotalPortfolioValue = previousState.totalValue || 0;
        const currentBalance = await getBalanceForComparison();

        if (!currentBalance) { await sendDebugMessage("فشل جلب الرصيد الحالي."); return; }
        
        const prices = await getMarketPrices();
        if (!prices) { await sendDebugMessage("فشل جلب الأسعار."); return; }

        const { total: newTotalPortfolioValue } = await getPortfolio(prices);
        if (newTotalPortfolioValue === undefined) { await sendDebugMessage("فشل جلب قيمة المحفظة الجديدة."); return; }

        if (Object.keys(previousBalanceState).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage("تم تسجيل الرصيد الأولي وحفظه.");
            return;
        }
        
        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;

            if (Math.abs(difference) < 1e-9) continue;
            
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price) {
                await sendDebugMessage(`لا يمكن العثور على سعر لـ ${asset}. سيتم تجاهل هذا التغيير.`);
                continue;
            }
            const price = priceData.price;
            
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);
            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }
            
            const tradeValue = Math.abs(difference) * price;
            const type = difference > 0 ? 'شراء' : 'بيع';
            let publicRecommendationText = "";
            let callbackData = "";
            const newAssetValue = currAmount * price;
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const timestamp = `*آخر تحديث: ${new Date().toLocaleDateString("en-GB").replace(/\//g,'.')}*`;

            if (type === 'شراء') {
                const entryOfPortfolio = previousTotalPortfolioValue > 0 ? (tradeValue / previousTotalPortfolioValue) * 100 : 0;
                const previousUSDTBalance = previousBalanceState['USDT'] || 0;
                const entryOfCash = previousUSDTBalance > 0 ? (tradeValue / previousUSDTBalance) * 100 : 0;
                publicRecommendationText = `🔔 **توصية تداول جديدة | شراء** 🟢\n\n` + `🔸 **العملة:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الصفقة:**\n` + `   💰 *متوسط السعر:* \`$${(price || 0).toFixed(4)}\`\n` + `   📦 *حجم الدخول:* \`${(entryOfPortfolio || 0).toFixed(2)}%\`\n\n` + `📊 **تأثيرها على المحفظة:**\n` + `   💵 *استهلاك الكاش:* \`${(entryOfCash || 0).toFixed(2)}%\`\n` + `   📈 *الوزن الجديد للعملة:* \`${(portfolioPercentage || 0).toFixed(2)}%\`\n\n${timestamp}`;
                callbackData = `publish_buy_${asset}_${(price || 0).toFixed(4)}_${(entryOfPortfolio || 0).toFixed(2)}_${(entryOfCash || 0).toFixed(2)}_${(portfolioPercentage || 0).toFixed(2)}`;
            } else { // Sell
                if (currAmount < 0.0001) { // Full close
                    publicRecommendationText = `🔔 **توصية تداول جديدة | إغلاق مركز** 🔴\n\n` + `🔸 **العملة:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الصفقة:**\n` + `   💰 *متوسط سعر البيع:* \`$${(price || 0).toFixed(4)}\`\n` + `   ✅ *النتيجة:* تم إغلاق المركز بالكامل.\n\n` + `📊 **التأثير على المحفظة:**\n` + `   💵 *تم استعادة:* \`$${(tradeValue || 0).toFixed(2)}\` إلى الكاش.\n` + `   📈 *الوزن الجديد للعملة:* \`0.00%\`\n\n${timestamp}`;
                    callbackData = `publish_close_${asset}_${(price || 0).toFixed(4)}_${(tradeValue || 0).toFixed(2)}`;
                } else { // Partial sell
                     publicRecommendationText = `🔔 **تحديث توصية | تخفيف** 🟠\n\n` + `🔸 **العملة:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الصفقة:**\n` + `   💰 *متوسط سعر البيع:* \`$${(price || 0).toFixed(4)}\`\n` + `   📉 *تم بيع:* جزء من الكمية\n\n` + `📊 **التأثير على المحفظة:**\n` + `   📈 *الوزن الجديد للعملة:* \`${(portfolioPercentage || 0).toFixed(2)}%\`\n\n${timestamp}`;
                     callbackData = `publish_sell_${asset}_${(price || 0).toFixed(4)}_${(portfolioPercentage || 0).toFixed(2)}`;
                }
            }
            const settings = await loadSettings();
            if (settings.autoPostToChannel && publicRecommendationText) {
                await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicRecommendationText, { parse_mode: "Markdown" });
            } else if (publicRecommendationText) {
                const confirmationKeyboard = new InlineKeyboard().text("✅ نشر في القناة", callbackData).text("❌ تجاهل", "ignore_trade");
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `*هل تريد نشر التوصية التالية في القناة؟*\n\n${publicRecommendationText}`, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
            }
            
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage(`State updated after processing trade for ${asset}.`);
            return;
        }
        
        await sendDebugMessage("لا توجد تغييرات.");
        await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
    }
}

async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let alertsTriggered = false; for (const alert of alerts) { const currentPrice = (prices[alert.instId] || {}).price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } let triggered = false; if (alert.condition === '>' && currentPrice > alert.price) triggered = true; else if (alert.condition === '<' && currentPrice < alert.price) triggered = true; if (triggered) { const message = `🚨 *تنبيه سعر!* 🚨\n\n- العملة: *${alert.instId}*\n- الشرط: تحقق (${alert.condition} ${alert.price})\n- السعر الحالي: *${currentPrice}*`; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); alertsTriggered = true; } else { remainingAlerts.push(alert); } } if (alertsTriggered) { await saveAlerts(remainingAlerts); } } catch (error) { console.error("Error in checkPriceAlerts:", error); } }

async function runDailyJobs() {
    try {
        console.log("Attempting to run daily jobs...");
        const settings = await loadSettings();
        if (!settings.dailySummary) { console.log("Daily summary is disabled. Skipping."); return; }
        const prices = await getMarketPrices();
        if (!prices) { console.error("Daily Jobs: Failed to get prices."); return; }
        const { total, error } = await getPortfolio(prices);
        if (error) { console.error("Daily Jobs Error:", error); return; }
        const history = await loadHistory();
        const date = new Date().toISOString().slice(0, 10);
        const todayRecordIndex = history.findIndex(h => h.date === date);
        if (todayRecordIndex > -1) { history[todayRecordIndex].total = total; } 
        else { history.push({ date: date, total: total }); }
        if (history.length > 35) history.shift();
        await saveHistory(history);
        console.log(`[✅ Daily Summary Recorded]: ${date} - $${(total || 0).toFixed(2)}`);
    } catch(e) { console.error("CRITICAL ERROR in runDailyJobs:", e); }
}

// vvv --- Re-added Feature: Price Movement Alerts --- vvv
async function checkPriceMovements() {
    try {
        await sendDebugMessage("بدء دورة التحقق من حركة الأسعار...");
        const alertSettings = await loadAlertSettings();
        const priceTracker = await loadPriceTracker();
        const prices = await getMarketPrices();
        if (!prices) { await sendDebugMessage("فشل جلب الأسعار، تخطي دورة فحص الحركة."); return; }
        const { assets, total: currentTotalValue, error } = await getPortfolio(prices);
        if (error || currentTotalValue === undefined) { await sendDebugMessage("فشل جلب المحفظة، تخطي دورة فحص الحركة."); return; }
        
        if (priceTracker.totalPortfolioValue === 0) {
            priceTracker.totalPortfolioValue = currentTotalValue;
            assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; });
            await savePriceTracker(priceTracker);
            await sendDebugMessage("تم تسجيل قيم تتبع الأسعار الأولية.");
            return;
        }

        let trackerUpdated = false;
        const lastTotalValue = priceTracker.totalPortfolioValue;

        if (lastTotalValue > 0) {
            const changePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100;
            if (Math.abs(changePercent) >= alertSettings.global) {
                const emoji = changePercent > 0 ? '🟢' : '🔴';
                const movementText = changePercent > 0 ? 'صعود' : 'هبوط';
                const message = `📊 *تنبيه حركة المحفظة!*\n\n*الحركة:* ${emoji} *${movementText}* \`${(changePercent || 0).toFixed(2)}%\`\n*القيمة الحالية:* \`$${(currentTotalValue || 0).toFixed(2)}\``;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                priceTracker.totalPortfolioValue = currentTotalValue;
                trackerUpdated = true;
            }
        }

        for (const asset of assets) {
            if (asset.asset === 'USDT' || !asset.price) continue;
            const lastPrice = priceTracker.assets[asset.asset];
            if (lastPrice) {
                const currentPrice = asset.price;
                const changePercent = ((currentPrice - lastPrice) / lastPrice) * 100;
                const threshold = alertSettings.overrides[asset.asset] || alertSettings.global;
                if (Math.abs(changePercent) >= threshold) {
                    const emoji = changePercent > 0 ? '🟢' : '🔴';
                    const movementText = changePercent > 0 ? 'صعود' : 'هبوط';
                    const message = `📈 *تنبيه حركة سعر!*\n\n*العملة:* \`${asset.asset}\`\n*الحركة:* ${emoji} *${movementText}* \`${(changePercent || 0).toFixed(2)}%\`\n*السعر الحالي:* \`$${(currentPrice || 0).toFixed(4)}\``;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                    priceTracker.assets[asset.asset] = currentPrice;
                    trackerUpdated = true;
                }
            } else {
                priceTracker.assets[asset.asset] = asset.price;
                trackerUpdated = true;
            }
        }
        
        if (trackerUpdated) {
            await savePriceTracker(priceTracker);
            await sendDebugMessage("تم تحديث متتبع الأسعار بعد إرسال تنبيه.");
        } else {
            await sendDebugMessage("لا توجد حركات أسعار تتجاوز الحد.");
        }
    } catch(e) {
        console.error("CRITICAL ERROR in checkPriceMovements:", e);
    }
}
// ^^^ End of Re-added Feature ^^^


const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();
    
async function sendSettingsMenu(ctx) { const settings = await loadSettings(); const settingsKeyboard = new InlineKeyboard().text("💰 تعيين رأس المال", "set_capital").text("💼 عرض المراكز", "view_positions").row().text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts").text("🗑️ حذف تنبيه سعر", "delete_alert").row().text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row().text(`🚀 النشر التلقائي: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row().text("🔥 حذف كل البيانات 🔥", "delete_all_data"); const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*"; try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } catch { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } }
async function sendMovementAlertsMenu(ctx) { const alertSettings = await loadAlertSettings(); const text = `🚨 *إدارة تنبيهات الحركة*\n\n- النسبة العامة الحالية: \`${alertSettings.global}%\`\n- يمكنك تعيين نسبة مختلفة لعملة معينة.`; const keyboard = new InlineKeyboard() .text("📊 تعديل النسبة العامة", "set_global_alert").row() .text("💎 تعديل نسبة عملة", "set_coin_alert").row() .text("📄 عرض كل الإعدادات", "view_movement_alerts").row() .text("🔙 العودة للإعدادات الرئيسية", "back_to_settings"); try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); } catch { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard }); } }

bot.use(async (ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) { await next(); } else { console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); } });
bot.command("start", async (ctx) => { await ctx.reply(`🤖 *بوت OKX التحليلي المتكامل*\n*الإصدار: v49 - Stable & Complete*`, { parse_mode: "Markdown", reply_markup: mainKeyboard }); });
bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));
bot.command("pnl", async (ctx) => { const args = ctx.match.trim().split(/\s+/); if (args.length !== 3 || args[0] === '') { return await ctx.reply(`❌ *صيغة غير صحيحة*\n\n` + `*يرجى استخدام الصيغة الصحيحة للأمر.*\n\n` + `*مثال:*\n\`/pnl <شراء> <بيع> <كمية>\``, { parse_mode: "Markdown" }); } const [buyPrice, sellPrice, quantity] = args.map(parseFloat); if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) { return await ctx.reply("❌ *خطأ:* تأكد من أن القيم أرقام موجبة."); } const totalInvestment = buyPrice * quantity; const totalSaleValue = sellPrice * quantity; const profitOrLoss = totalSaleValue - totalInvestment; const pnlPercentage = (profitOrLoss / totalInvestment) * 100; const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻"; const pnlSign = profitOrLoss >= 0 ? '+' : ''; const responseMessage = `🧮 *نتيجة حساب الربح والخسارة*\n\n` + `📝 **المدخلات:**\n` + `   - *سعر الشراء:* \`$${buyPrice.toLocaleString()}\`\n` + `   - *سعر البيع:* \`$${sellPrice.toLocaleString()}\`\n` + `   - *الكمية:* \`${quantity.toLocaleString()}\`\n\n` + `📊 **النتائج:**\n` + `   - *إجمالي الشراء:* \`$${totalInvestment.toLocaleString()}\`\n` + `   - *إجمالي البيع:* \`$${totalSaleValue.toLocaleString()}\`\n` + `   - *صافي الربح:* \`${pnlSign}${profitOrLoss.toLocaleString()}\` (\`${pnlSign}${(pnlPercentage || 0).toFixed(2)}%\`)\n\n` + `**${resultStatus}**`; await ctx.reply(responseMessage, { parse_mode: "Markdown" }); });

bot.on("callback_query:data", async (ctx) => {
    try { await ctx.answerCallbackQuery(); } catch (e) { console.log("Could not answer old callback query, ignoring. Error:", e.message); }
    const data = ctx.callbackQuery.data;
    if (!ctx.callbackQuery.message) { console.log("Callback query has no message, skipping."); return; }

    if (data.startsWith("chart_")) {
        const period = data.split('_')[1];
        await ctx.editMessageText("⏳ جاري إنشاء التقرير...");
        let history, periodLabel, periodData;
        if (period === '24h') { history = await loadHourlyHistory(); periodLabel = "آخر 24 ساعة"; periodData = history.slice(-24); }
        else if (period === '7d') { history = await loadHistory(); periodLabel = "آخر 7 أيام"; periodData = history.slice(-7).map(h => ({ label: h.date.slice(5), total: h.total })); }
        else if (period === '30d') { history = await loadHistory(); periodLabel = "آخر 30 يومًا"; periodData = history.slice(-30).map(h => ({ label: h.date.slice(5), total: h.total })); }
        
        if (!periodData || periodData.length < 2) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); return; }
        const stats = calculatePerformanceStats(periodData);
        if (!stats) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); return; }
        const chartUrl = createChartUrl(periodData, periodLabel);
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const pnlSign = stats.pnl >= 0 ? '+' : '';
        const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` + `📈 **النتيجة:** ${pnlEmoji} \`${pnlSign}${(stats.pnl || 0).toFixed(2)}\` (\`${pnlSign}${(stats.pnlPercent || 0).toFixed(2)}%\`)\n` + `*التغير الصافي: من \`$${(stats.startValue || 0).toFixed(2)}\` إلى \`$${(stats.endValue || 0).toFixed(2)}\`*\n\n` + `📝 **ملخص الفترة:**\n` + `   ⬆️ *أعلى قيمة:* \`$${(stats.maxValue || 0).toFixed(2)}\`\n` + `   ⬇️ *أدنى قيمة:* \`$${(stats.minValue || 0).toFixed(2)}\`\n` + `   📊 *متوسط القيمة:* \`$${(stats.avgValue || 0).toFixed(2)}\`\n\n`+ `*التقرير تم إنشاؤه في: ${new Date().toLocaleDateString("en-GB").replace(/\//g,'.')}*`;
        try { await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" }); await ctx.deleteMessage(); } catch(e) { console.error("Failed to send chart:", e); await ctx.editMessageText("❌ فشل إنشاء الرسم البياني."); }
        return;
    }
    
    if (data.startsWith("publish_")) {
        let finalRecommendation = ctx.callbackQuery.message.text.replace("*هل تريد نشر التوصية التالية في القناة؟*\n\n", "");
        try {
            await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, finalRecommendation, { parse_mode: "Markdown" });
            await ctx.editMessageText("✅ تم النشر في القناة بنجاح.", { reply_markup: undefined });
        } catch (e) {
            console.error("Failed to post to channel:", e);
            await ctx.editMessageText("❌ فشل النشر في القناة.", { reply_markup: undefined });
        }
        return;
    }
    if (data === "ignore_trade") {
        await ctx.editMessageText("❌ تم تجاهل الصفقة.", { reply_markup: undefined });
        return;
    }

    switch (data) {
        case "view_positions":
            const positions = await loadPositions();
            if (Object.keys(positions).length === 0) { await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة يتتبعها البوت حاليًا.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); } else {
                let msg = "📄 *المراكز المفتوحة التي يتم تتبعها تلقائيًا:*\n";
                for (const symbol in positions) {
                    const pos = positions[symbol];
                    msg += `\n╭─ *${symbol}*`;
                    const avgBuyPriceText = pos && pos.avgBuyPrice ? `$${pos.avgBuyPrice.toFixed(4)}` : 'غير متاح';
                    const totalAmountText = pos && pos.totalAmountBought ? pos.totalAmountBought.toFixed(6) : 'غير متاح';
                    const openDateText = pos && pos.openDate ? new Date(pos.openDate).toLocaleDateString('en-GB') : 'غير متاح';
                    msg += `\n├─ 🛒 *متوسط الشراء:* \`${avgBuyPriceText}\``;
                    msg += `\n├─ 📦 *الكمية المشتراة:* \`${totalAmountText}\``;
                    msg += `\n╰─ 🗓️ *تاريخ الفتح:* \`${openDateText}\``;
                }
                await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") });
            }
            break;
        case "back_to_settings": await sendSettingsMenu(ctx); break;
        case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
        case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.editMessageText("✍️ أرسل النسبة المئوية العامة الجديدة (رقم فقط)."); break;
        case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.editMessageText("✍️ أرسل رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`\n(للحذف أرسل نسبة 0)"); break;
        case "view_movement_alerts":
            const alertSettings = await loadAlertSettings();
            let msg_alerts = `🚨 *إعدادات تنبيهات الحركة:*\n\n` + `*النسبة العامة:* \`${alertSettings.global}%\`\n` + `--------------------\n*النسب المخصصة:*\n`;
            if (Object.keys(alertSettings.overrides).length === 0) { msg_alerts += "لا توجد." } else { for (const coin in alertSettings.overrides) { msg_alerts += `- *${coin}:* \`${alertSettings.overrides[coin]}%\`\n`; } }
            await ctx.editMessageText(msg_alerts, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة", "manage_movement_alerts") });
            break;
        case "set_capital": waitingState = 'set_capital'; await ctx.editMessageText("💰 أرسل المبلغ الجديد لرأس المال.", { reply_markup: undefined }); break;
        case "delete_alert":
            const alerts = await loadAlerts();
            if (alerts.length === 0) {
                await ctx.editMessageText("ℹ️ لا توجد تنبيهات سعر مسجلة لحذفها.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") });
            } else {
                let msg = "🗑️ *التنبيهات المسجلة:*\n\n";
                alerts.forEach((alert, index) => {
                    msg += `*${index + 1}.* \`${alert.instId}\` ${alert.condition} \`${alert.price}\`\n`;
                });
                msg += "\n*أرسل رقم التنبيه الذي تريد حذفه.*";
                waitingState = 'delete_alert_number';
                await ctx.editMessageText(msg, { parse_mode: "Markdown" });
            }
            break;
        case "toggle_summary": case "toggle_autopost": case "toggle_debug": { let settings = await loadSettings(); if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary; else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel; else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode; await saveSettings(settings); await sendSettingsMenu(ctx); } break;
        case "delete_all_data": waitingState = 'confirm_delete_all'; await ctx.editMessageText("⚠️ *هل أنت متأكد؟*\nأرسل `تأكيد الحذف` للمتابعة.", { parse_mode: "Markdown", reply_markup: undefined }); setTimeout(() => { if (waitingState === 'confirm_delete_all') waitingState = null; }, 30000); break;
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (ctx.message.text && ctx.message.text.startsWith('/')) { return; }
    
    // Main menu handlers
    switch(text) {
        case "📊 عرض المحفظة":
            await ctx.reply("⏳ جاري جلب بيانات المحفظة...");
            const pricesPortfolio = await getMarketPrices();
            if (!pricesPortfolio) { return await ctx.reply("❌ فشل في جلب أسعار السوق."); }
            const capital = await loadCapital();
            const { assets, total, error } = await getPortfolio(pricesPortfolio);
            if (error) { return await ctx.reply(`❌ ${error}`); }
            const msgPortfolio = await formatPortfolioMsg(assets, total, capital);
            await ctx.reply(msgPortfolio, { parse_mode: "Markdown" });
            return;
        case "📈 أداء المحفظة":
            const performanceKeyboard = new InlineKeyboard().text("آخر 24 ساعة", "chart_24h").row().text("آخر 7 أيام", "chart_7d").row().text("آخر 30 يومًا", "chart_30d");
            await ctx.reply("اختر الفترة الزمنية لعرض أداء المحفظة:", { reply_markup: performanceKeyboard });
            return;
        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            await ctx.reply("✍️ أرسل رمز العملة (مثال: `BTC-USDT`)");
            return;
        case "⚙️ الإعدادات":
            await sendSettingsMenu(ctx);
            return;
        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            await ctx.reply("✍️ *أرسل تنبيه السعر بالصيغة التالية:*\n`<رمز العملة> < > أو < > <السعر>`\n\n*أمثلة:*\n`BTC-USDT > 70000`\n`ETH-USDT < 3500`", { parse_mode: "Markdown" });
            return;
        case "🧮 حاسبة الربح والخسارة":
             await ctx.reply("✍️ لحساب الربح/الخسارة، استخدم أمر `/pnl`.\n\n*مثال:*\n`/pnl 50000 60000 0.5`", { parse_mode: "Markdown" });
             return;
    }

    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            case 'set_capital': const amount = parseFloat(text); if (!isNaN(amount) && amount >= 0) { await saveCapital(amount); await ctx.reply(`✅ *تم تحديث رأس المال*\n\n💰 **المبلغ الجديد:** \`$${(amount || 0).toFixed(2)}\``, {parse_mode: "Markdown"}); } else { await ctx.reply("❌ مبلغ غير صالح."); } return;
            case 'set_global_alert_state': const percent = parseFloat(text); if (isNaN(percent) || percent <= 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا."); } let alertSettingsGlobal = await loadAlertSettings(); alertSettingsGlobal.global = percent; await saveAlertSettings(alertSettingsGlobal); await ctx.reply(`✅ تم تحديث النسبة العامة إلى \`${percent}%\`.`); return;
            case 'set_coin_alert_state': const parts_coin_alert = text.split(/\s+/); if (parts_coin_alert.length !== 2) { return await ctx.reply("❌ *صيغة غير صحيحة*. يرجى إرسال رمز العملة ثم النسبة."); } const [symbol_coin_alert, percentStr_coin_alert] = parts_coin_alert; const coinPercent = parseFloat(percentStr_coin_alert); if (isNaN(coinPercent) || coinPercent < 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا."); } let alertSettingsCoin = await loadAlertSettings(); if (coinPercent === 0) { delete alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()]; await ctx.reply(`✅ تم حذف النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* وستتبع النسبة العامة.`); } else { alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()] = coinPercent; await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* إلى \`${coinPercent}%\`.`); } await saveAlertSettings(alertSettingsCoin); return;
            case 'coin_info':
                const instId = text.toUpperCase();
                await ctx.reply(`⏳ جاري البحث عن معلومات ${instId}...`);
                const details = await getInstrumentDetails(instId);
                if (details.error) { return await ctx.reply(`❌ ${details.error}`); }
                
                let msg = `ℹ️ *معلومات عملة | ${instId}*\n\n` + `   💲 *السعر الحالي:* \`$${(details.price || 0).toFixed(4)}\`\n` + `   📈 *أعلى سعر (24س):* \`$${(details.high24h || 0).toFixed(4)}\`\n` + `   📉 *أدنى سعر (24س):* \`$${(details.low24h || 0).toFixed(4)}\`\n\n` + `   📅 *النطاق الأسبوعي (آخر 7 أيام):*\n` + `   ⬆️ *أعلى سعر:* \`$${(details.weeklyHigh || 0).toFixed(4)}\`\n` + `   ⬇️ *أدنى سعر:* \`$${(details.weeklyLow || 0).toFixed(4)}\`\n\n` + `   📊 *حجم التداول (24س):* \`$${(details.vol24h || 0).toLocaleString()}\`\n\n` + `*البيانات من منصة OKX*`;
                
                const prices = await getMarketPrices();
                if (prices) {
                    const { assets: userAssets } = await getPortfolio(prices);
                    const coinSymbol = instId.split('-')[0];
                    const ownedAsset = userAssets.find(a => a.asset === coinSymbol);
                    const positions = await loadPositions();
                    const assetPosition = positions[coinSymbol];
        
                    if (ownedAsset && assetPosition && assetPosition.avgBuyPrice) {
                        const amount = ownedAsset.amount;
                        const avgBuyPrice = assetPosition.avgBuyPrice;
                        const totalCost = avgBuyPrice * amount;
                        const totalPnl = (details.price * amount) - totalCost;
                        const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
                        const totalPnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
                        const totalPnlSign = totalPnl >= 0 ? '+' : '';
        
                        const dailyPnl = (details.price - details.open24h) * amount;
                        const dailyPnlEmoji = dailyPnl >= 0 ? '🟢' : '🔴';
                        const dailyPnlSign = dailyPnl >= 0 ? '+' : '';
        
                        msg += `\n\n━━━━━━━━━━━━━━━━━━━━\n` + `📊 *موقفك في العملة:*\n` + `   - *ربح إجمالي غير محقق:* ${totalPnlEmoji} \`${totalPnlSign}${(totalPnl || 0).toFixed(2)}\` (\`${totalPnlSign}${(totalPnlPercent || 0).toFixed(2)}%\`)\n` + `   - *الربح/الخسارة (آخر 24س):* ${dailyPnlEmoji} \`${dailyPnlSign}${(dailyPnl || 0).toFixed(2)}\``;
                    }
                }
                await ctx.reply(msg, { parse_mode: "Markdown" });
                return;
            case 'set_alert':
                const parts = text.trim().split(/\s+/);
                if (parts.length !== 3) { return await ctx.reply("❌ صيغة غير صحيحة. يرجى استخدام الصيغة: `SYMBOL > PRICE`"); }
                const [alertInstId, condition, priceStr] = parts;
                if (condition !== '>' && condition !== '<') { return await ctx.reply("❌ الشرط غير صالح. استخدم `>` أو `<` فقط."); }
                const alertPrice = parseFloat(priceStr);
                if (isNaN(alertPrice) || alertPrice <= 0) { return await ctx.reply("❌ السعر غير صالح."); }
                const alertsList = await loadAlerts();
                alertsList.push({ instId: alertInstId.toUpperCase(), condition: condition, price: alertPrice });
                await saveAlerts(alertsList);
                await ctx.reply(`✅ تم ضبط التنبيه:\n*${alertInstId.toUpperCase()}* سيتم تنبيهك إذا كان السعر ${condition} *${alertPrice}*`, { parse_mode: "Markdown" });
                return;
            case 'delete_alert_number':
                const alertIndex = parseInt(text) - 1;
                let currentAlerts = await loadAlerts();
                if (isNaN(alertIndex) || alertIndex < 0 || alertIndex >= currentAlerts.length) {
                    return await ctx.reply("❌ رقم غير صالح. الرجاء الاختيار من القائمة.");
                }
                const removedAlert = currentAlerts.splice(alertIndex, 1)[0];
                await saveAlerts(currentAlerts);
                await ctx.reply(`✅ تم حذف التنبيه بنجاح:\n\`${removedAlert.instId} ${removedAlert.condition} ${removedAlert.price}\``, { parse_mode: "Markdown" });
                return;
            case 'confirm_delete_all': if (text === 'تأكيد الحذف') { await getCollection("configs").deleteMany({}); await ctx.reply("✅ تم حذف جميع البيانات بنجاح."); } else { await ctx.reply("❌ تم إلغاء عملية الحذف."); } return;
        }
    }
});

// Start the bot
async function startBot() {
    await connectDB();
    console.log("Database connected!");

    if (process.env.NODE_ENV === "production") {
        app.use(express.json());
        app.use(webhookCallback(bot, "express"));
        app.listen(PORT, () => {
            console.log(`Bot v49 (Stable & Complete) listening on port ${PORT}`);
        });
    } else {
        bot.start();
        console.log("Bot v49 (Stable & Complete) started with polling.");
    }

    // Set interval timers for recurring tasks
    setInterval(monitorBalanceChanges, 60000); // Check every 60 seconds
    setInterval(checkPriceAlerts, 30000);      // Check every 30 seconds
    setInterval(runDailyJobs, 3600000);        // Check every hour for daily job
    setInterval(checkPriceMovements, 60000);   // Check every 60 seconds
}

startBot();
