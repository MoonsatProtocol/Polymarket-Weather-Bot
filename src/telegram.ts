/**
 * Telegram notification system
 *
 * Sends two daily messages to your Telegram account:
 *   7:00 am Melbourne — morning briefing (what was bought, win estimates)
 *   7:00 pm Melbourne — evening summary (PnL, win rate, closed trades)
 *
 * Setup (one-time):
 *   1. Message @BotFather on Telegram → /newbot → copy the token
 *   2. Message your new bot once, then run:
 *        curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
 *      Copy the "id" from chat.id in the response
 *   3. Add to .env:
 *        TELEGRAM_BOT_TOKEN=123456789:ABCdef...
 *        TELEGRAM_CHAT_ID=987654321
 */

import fs from "fs/promises";
import path from "path";
import axios from "./http";
import { SimulationState, Position } from "./simState";

const STATE_FILE = path.resolve(__dirname, "..", ".notification-state.json");

// ── Types ─────────────────────────────────────────────────────────────────────

interface NotificationState {
  morning?: string; // last date morning was sent (YYYY-MM-DD Melbourne)
  evening?: string; // last date evening was sent
}

// ── Timezone helper ───────────────────────────────────────────────────────────

/** Returns current hour and date string in Melbourne time (handles DST). */
function melbourneTime(): { hour: number; dateStr: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "numeric", hour12: false
  }).formatToParts(now);

  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "0";
  const hour    = parseInt(get("hour"), 10);
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  return { hour, dateStr };
}

// ── State helpers ─────────────────────────────────────────────────────────────

async function loadState(): Promise<NotificationState> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as NotificationState;
  } catch {
    return {};
  }
}

async function saveState(state: NotificationState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ── Message builders ──────────────────────────────────────────────────────────

function esc(text: string): string {
  // Escape MarkdownV2 special chars
  return text.replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

function buildMorningReport(sim: SimulationState): string {
  const positions = Object.values(sim.positions);
  const today     = new Date().toLocaleDateString("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "numeric", month: "short", year: "numeric"
  });

  const lines: string[] = [
    `🌤 *Weatherbot Morning Report*`,
    `_${esc(today)}_`,
    ``
  ];

  if (positions.length === 0) {
    lines.push(`📭 No open positions — bot found no qualifying markets today\\.`);
  } else {
    lines.push(`📋 *Open positions \\(${positions.length}\\):*`);
    lines.push(``);

    for (const pos of positions) {
      const closesAt = pos.closes_at ? new Date(pos.closes_at) : null;
      const hoursLeft = closesAt
        ? Math.max(0, (closesAt.getTime() - Date.now()) / 3_600_000)
        : null;
      const closeStr = hoursLeft != null ? `closes in ${hoursLeft.toFixed(0)}h` : "unknown close";
      const winPct   = pos.our_prob != null ? `${(pos.our_prob * 100).toFixed(0)}%` : "n/a";
      const city     = (pos.location ?? "").charAt(0).toUpperCase() + (pos.location ?? "").slice(1);
      const q        = pos.question.replace(/Will the highest temperature in /i, "").replace(/ on .*$/, "");

      lines.push(
        `📍 *${esc(city)}* — ${esc(q)}`,
        `   Entry: \\$${esc(pos.entry_price.toFixed(3))} · Size: \\$${esc(pos.cost.toFixed(0))} · Est win: *${esc(winPct)}* · ${esc(closeStr)}`
      );
    }

    const avgWinProb = positions.reduce((s, p) => s + (p.our_prob ?? 0), 0) / positions.length;
    const totalDeployed = positions.reduce((s, p) => s + p.cost, 0);

    lines.push(``);
    lines.push(`💰 *Balance:* \\$${esc(sim.balance.toFixed(2))}`);
    lines.push(`💼 *Deployed:* \\$${esc(totalDeployed.toFixed(2))}`);
    lines.push(`🎯 *Avg win estimate:* ${esc((avgWinProb * 100).toFixed(0))}%`);
    lines.push(`🔢 *Total trades all\\-time:* ${sim.total_trades}`);
  }

  return lines.join("\n");
}

function buildEveningReport(sim: SimulationState): string {
  const today = new Date().toLocaleDateString("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "numeric", month: "short", year: "numeric"
  });

  const closedToday = sim.trades.filter(t => {
    if (t.type !== "exit" || !t.closed_at) return false;
    const d = new Date(t.closed_at).toLocaleDateString("en-AU", {
      timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric"
    });
    const todayFmt = new Date().toLocaleDateString("en-AU", {
      timeZone: "Australia/Melbourne", day: "2-digit", month: "2-digit", year: "numeric"
    });
    return d === todayFmt;
  });

  const totalPnl     = closedToday.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winsToday    = closedToday.filter(t => (t.pnl ?? 0) > 0).length;
  const lossesToday  = closedToday.filter(t => (t.pnl ?? 0) <= 0).length;
  const returnPct    = ((sim.balance - sim.starting_balance) / sim.starting_balance) * 100;
  const allTimeWinRate = (sim.wins + sim.losses) > 0
    ? (sim.wins / (sim.wins + sim.losses)) * 100
    : 0;

  const lines: string[] = [
    `📊 *Weatherbot Evening Report*`,
    `_${esc(today)}_`,
    ``
  ];

  // Today's P&L
  const pnlSign = totalPnl >= 0 ? "\\+" : "";
  lines.push(`💰 *Balance:* \\$${esc(sim.balance.toFixed(2))} \\(${esc(returnPct >= 0 ? "+" : "")}${esc(returnPct.toFixed(1))}% all\\-time\\)`);
  lines.push(`📈 *Today's P&L:* ${pnlSign}\\$${esc(Math.abs(totalPnl).toFixed(2))} \\(${winsToday}W / ${lossesToday}L today\\)`);
  lines.push(`🏆 *All\\-time win rate:* ${esc(allTimeWinRate.toFixed(0))}% \\(${sim.wins}W / ${sim.losses}L\\)`);
  lines.push(`🔢 *Total trades:* ${sim.total_trades}`);
  lines.push(``);

  // Closed trades today
  if (closedToday.length === 0) {
    lines.push(`_No trades closed today\\._`);
  } else {
    const winners = closedToday.filter(t => (t.pnl ?? 0) > 0);
    const losers  = closedToday.filter(t => (t.pnl ?? 0) <= 0);

    if (winners.length > 0) {
      lines.push(`✅ *Winners:*`);
      for (const t of winners) {
        const city = (t.location ?? "").charAt(0).toUpperCase() + (t.location ?? "").slice(1);
        lines.push(`   ${esc(city)} — \\+\\$${esc((t.pnl ?? 0).toFixed(2))} \\(entry \\$${esc((t.entry_price ?? 0).toFixed(3))} → \\$${esc((t.exit_price ?? 0).toFixed(3))}\\)`);
      }
      lines.push(``);
    }

    if (losers.length > 0) {
      lines.push(`❌ *Losers:*`);
      for (const t of losers) {
        const city = (t.location ?? "").charAt(0).toUpperCase() + (t.location ?? "").slice(1);
        lines.push(`   ${esc(city)} — \\-\\$${esc(Math.abs(t.pnl ?? 0).toFixed(2))} \\(entry \\$${esc((t.entry_price ?? 0).toFixed(3))} → \\$${esc((t.exit_price ?? 0).toFixed(3))}\\)`);
      }
      lines.push(``);
    }
  }

  // Still open
  const openCount = Object.keys(sim.positions).length;
  if (openCount > 0) {
    const openCost = Object.values(sim.positions).reduce((s, p) => s + p.cost, 0);
    lines.push(`⏳ *Still open:* ${openCount} position${openCount > 1 ? "s" : ""} \\(\\$${esc(openCost.toFixed(2))} at risk\\)`);
  }

  return lines.join("\n");
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await axios.post(url, {
    chat_id:    chatId,
    text,
    parse_mode: "MarkdownV2"
  }, { timeout: 10_000 });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called after every bot run. Checks if it's within the 7am or 7pm Melbourne
 * window and sends the appropriate notification if not already sent today.
 */
export async function maybeSendNotification(
  sim: SimulationState,
  token: string | undefined,
  chatId: string | undefined
): Promise<void> {
  if (!token || !chatId) return; // not configured — skip silently

  const { hour, dateStr } = melbourneTime();
  const state = await loadState();

  // Morning window: 7:00–7:59 am Melbourne
  if (hour === 7 && state.morning !== dateStr) {
    try {
      await sendMessage(token, chatId, buildMorningReport(sim));
      state.morning = dateStr;
      await saveState(state);
      console.info("  📱 Morning Telegram report sent");
    } catch (e) {
      console.warn(`  ⚠️  Telegram morning send failed: ${String(e)}`);
    }
  }

  // Evening window: 19:00–19:59 (7pm) Melbourne
  if (hour === 19 && state.evening !== dateStr) {
    try {
      await sendMessage(token, chatId, buildEveningReport(sim));
      state.evening = dateStr;
      await saveState(state);
      console.info("  📱 Evening Telegram report sent");
    } catch (e) {
      console.warn(`  ⚠️  Telegram evening send failed: ${String(e)}`);
    }
  }
}
