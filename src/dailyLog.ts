/**
 * Daily performance log
 *
 * Appends one snapshot entry to daily-log.json at the end of every bot run.
 * If the bot runs multiple times in a day the entry for that date is overwritten
 * with the latest state, so there is always exactly one row per calendar day.
 *
 * The log file is append-only and never trimmed — it is the full historical
 * record of the bot's performance since it first ran.
 */

import fs from "fs/promises";
import path from "path";
import { SimulationState } from "./simState";

const LOG_FILE = path.resolve(__dirname, "..", "daily-log.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyLogEntry {
  /** Calendar date this snapshot represents (YYYY-MM-DD, local time) */
  date: string;
  /** Exact ISO timestamp of when this snapshot was written */
  timestamp: string;

  // ── Balance ──────────────────────────────────────────────────────────────
  balance: number;
  starting_balance: number;
  peak_balance: number;
  /** (balance − starting_balance) / starting_balance × 100 */
  total_return_pct: number;
  /** (peak_balance − balance) / peak_balance × 100 */
  drawdown_from_peak_pct: number;

  // ── Positions ────────────────────────────────────────────────────────────
  open_positions: number;
  /** Sum of cost across all open positions */
  deployed_capital: number;
  /** deployed_capital / balance × 100 */
  open_risk_pct: number;

  // ── Trade history ────────────────────────────────────────────────────────
  total_trades: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses) × 100, or 0 if no closed trades */
  win_rate_pct: number;
  /** Sum of PnL on winning closed trades */
  gross_profit: number;
  /** Sum of |PnL| on losing closed trades */
  gross_loss: number;
  /** gross_profit / gross_loss, or null if no losses yet */
  profit_factor: number | null;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Build a DailyLogEntry from the current SimulationState, then upsert it into
 * daily-log.json (overwrite same-day entry, otherwise append).
 */
export async function appendDailyLog(sim: SimulationState): Promise<void> {
  // ── Load existing log ────────────────────────────────────────────────────
  let log: DailyLogEntry[] = [];
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    log = JSON.parse(raw) as DailyLogEntry[];
  } catch {
    // File doesn't exist yet — start fresh
  }

  // ── Compute derived metrics ──────────────────────────────────────────────
  const today       = new Date().toISOString().slice(0, 10);
  const openCost    = Object.values(sim.positions).reduce((s, p) => s + p.cost, 0);
  const openRiskPct = sim.balance > 0 ? (openCost / sim.balance) * 100 : 0;

  const totalReturn   = ((sim.balance - sim.starting_balance) / sim.starting_balance) * 100;
  const drawdown      = sim.peak_balance > 0
    ? ((sim.peak_balance - sim.balance) / sim.peak_balance) * 100
    : 0;

  const closedTrades  = sim.trades.filter(t => t.type === "exit");
  const closedCount   = sim.wins + sim.losses;
  const winRate       = closedCount > 0 ? (sim.wins / closedCount) * 100 : 0;
  const grossProfit   = closedTrades
    .filter(t => (t.pnl ?? 0) > 0)
    .reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss     = closedTrades
    .filter(t => (t.pnl ?? 0) <= 0)
    .reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0);
  const profitFactor  = grossLoss > 0 ? grossProfit / grossLoss : null;

  const entry: DailyLogEntry = {
    date:                   today,
    timestamp:              new Date().toISOString(),
    balance:                Number(sim.balance.toFixed(2)),
    starting_balance:       Number(sim.starting_balance.toFixed(2)),
    peak_balance:           Number(sim.peak_balance.toFixed(2)),
    total_return_pct:       Number(totalReturn.toFixed(2)),
    drawdown_from_peak_pct: Number(drawdown.toFixed(2)),
    open_positions:         Object.keys(sim.positions).length,
    deployed_capital:       Number(openCost.toFixed(2)),
    open_risk_pct:          Number(openRiskPct.toFixed(1)),
    total_trades:           sim.total_trades,
    wins:                   sim.wins,
    losses:                 sim.losses,
    win_rate_pct:           Number(winRate.toFixed(1)),
    gross_profit:           Number(grossProfit.toFixed(2)),
    gross_loss:             Number(grossLoss.toFixed(2)),
    profit_factor:          profitFactor != null ? Number(profitFactor.toFixed(2)) : null
  };

  // ── Upsert: overwrite today's row if it exists, else append ─────────────
  const idx = log.findIndex(e => e.date === today);
  if (idx >= 0) {
    log[idx] = entry;
  } else {
    log.push(entry);
  }

  await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2), "utf8");
}
