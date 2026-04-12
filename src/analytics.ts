import { SimulationState } from "./simState";
import { C, info } from "./colors";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LocationStats {
  wins:        number;
  losses:      number;
  win_rate_pct: number;
}

export interface Analytics {
  win_rate_pct:       number;
  avg_win:            number;
  avg_loss:           number;
  profit_factor:      number;
  max_drawdown_pct:   number;
  consecutive_losses: number;
  by_location:        Record<string, LocationStats>;
}

// ── Core computation ──────────────────────────────────────────────────────────

/**
 * Derive analytics entirely from the existing SimulationState — no schema changes.
 * All fields are computed at read-time from `sim.trades`, `sim.balance`,
 * and `sim.starting_balance`.
 */
export function computeAnalytics(sim: SimulationState): Analytics {
  const exits = sim.trades.filter((t) => t.type === "exit");

  // ── Win / loss split ────────────────────────────────────────────────────
  const winTrades  = exits.filter((t) => (t.pnl ?? 0) > 0);
  const lossTrades = exits.filter((t) => (t.pnl ?? 0) <= 0);

  const win_rate_pct =
    exits.length > 0 ? (winTrades.length / exits.length) * 100 : 0;

  const avg_win =
    winTrades.length > 0
      ? winTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / winTrades.length
      : 0;

  const avg_loss =
    lossTrades.length > 0
      ? lossTrades.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0) /
        lossTrades.length
      : 0;

  // ── Profit factor ────────────────────────────────────────────────────────
  const totalWins   = winTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalLosses = lossTrades.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0);
  const profit_factor =
    totalLosses > 0
      ? totalWins / totalLosses
      : totalWins > 0
      ? 999        // infinite — no losses recorded
      : 1;

  // ── Max drawdown from balance curve implied by closed trades ────────────
  let peak            = sim.starting_balance;
  let runningBalance  = sim.starting_balance;
  let max_drawdown_pct = 0;

  for (const trade of exits) {
    runningBalance += trade.pnl ?? 0;
    if (runningBalance > peak) peak = runningBalance;
    const dd = peak > 0 ? ((peak - runningBalance) / peak) * 100 : 0;
    if (dd > max_drawdown_pct) max_drawdown_pct = dd;
  }

  // ── Current consecutive loss streak (count backwards from last trade) ───
  let consecutive_losses = 0;
  for (let i = exits.length - 1; i >= 0; i--) {
    if ((exits[i].pnl ?? 0) <= 0) consecutive_losses++;
    else break;
  }

  // ── Per-location breakdown ───────────────────────────────────────────────
  const by_location: Record<string, LocationStats> = {};

  for (const trade of exits) {
    const loc = trade.location ?? "unknown";
    if (!by_location[loc]) by_location[loc] = { wins: 0, losses: 0, win_rate_pct: 0 };
    if ((trade.pnl ?? 0) > 0) by_location[loc].wins++;
    else                       by_location[loc].losses++;
  }

  for (const loc of Object.keys(by_location)) {
    const { wins: w, losses: l } = by_location[loc];
    by_location[loc].win_rate_pct = w + l > 0 ? (w / (w + l)) * 100 : 0;
  }

  return {
    win_rate_pct,
    avg_win,
    avg_loss,
    profit_factor,
    max_drawdown_pct,
    consecutive_losses,
    by_location
  };
}

// ── Console output ────────────────────────────────────────────────────────────

export function printAnalytics(analytics: Analytics): void {
  const {
    win_rate_pct,
    avg_win,
    avg_loss,
    profit_factor,
    max_drawdown_pct,
    consecutive_losses,
    by_location
  } = analytics;

  console.log(`\n${C.BOLD("📈 Performance Analytics:")}`);

  const wrColor = win_rate_pct >= 50 ? C.GREEN : C.YELLOW;
  info(`Win rate:          ${wrColor(`${win_rate_pct.toFixed(1)}%`)}`);
  info(`Avg win:           ${C.GREEN(`$${avg_win.toFixed(2)}`)}`);
  info(`Avg loss:          ${C.YELLOW(`$${avg_loss.toFixed(2)}`)}`);

  const pfStr = profit_factor === 999 ? "∞" : profit_factor.toFixed(2);
  const pfColor = profit_factor >= 1 ? C.GREEN : C.YELLOW;
  info(`Profit factor:     ${pfColor(pfStr)}`);

  const ddColor = max_drawdown_pct < 10 ? C.GREEN : max_drawdown_pct < 25 ? C.YELLOW : C.RED;
  info(`Max drawdown:      ${ddColor(`${max_drawdown_pct.toFixed(1)}%`)}`);

  if (consecutive_losses >= 2) {
    info(`Consecutive losses: ${C.YELLOW(String(consecutive_losses))} ⚠️`);
  }

  // Per-location table
  const locs = Object.keys(by_location).sort();
  if (locs.length > 0) {
    console.log(`\n${C.BOLD("📍 Performance by Location:")}`);
    for (const loc of locs) {
      const { wins, losses, win_rate_pct: wr } = by_location[loc];
      const wrStr   = wr >= 50 ? C.GREEN(`${wr.toFixed(0)}%`) : C.YELLOW(`${wr.toFixed(0)}%`);
      const total   = wins + losses;
      info(`  ${loc.padEnd(15)} W/L: ${String(wins).padStart(2)}/${String(losses).padStart(2)}  (${wrStr})  n=${total}`);
    }
  }
}
