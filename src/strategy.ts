import { BotConfig, getActiveLocations } from "./config";
import { C, info, ok, skip, warn } from "./colors";
import { LOCATIONS, getForecast } from "./nws";
import { getHistoricalDailyMax, historicalBucketFrequency } from "./openmeteo";
import { hoursUntilResolution, parseTempRange, forecastInMarketUnit } from "./parsing";
import {
  PolymarketEvent,
  PolymarketMarket,
  getPolymarketEvent,
  getMarketYesPrice
} from "./polymarket";
import {
  Position,
  SimulationState,
  Trade,
  loadSim,
  saveSim
} from "./simState";
import { MONTHS } from "./time";
import { computeAnalytics, printAnalytics } from "./analytics";
import { appendDailyLog } from "./dailyLog";

// ── Kelly helpers ─────────────────────────────────────────────────────────────

/**
 * Estimate win probability by blending two independent signals:
 *
 *  1. NWS signal — base confidence decays with forecast horizon (day 0 ≈ 82%,
 *     day 6+ ≈ 40%); hourly temp stability around the forecast peak lifts it.
 *
 *  2. Historical climatology (Open-Meteo) — fraction of same-calendar-period
 *     days over the past 3 years where the daily max fell in the target bucket.
 *
 * Blend weights shift with forecast horizon:
 *   day 0-1  → 70 % NWS  / 30 % history  (short range: trust the model)
 *   day 3    → 50 % / 50 %
 *   day 5-6  → 30 % NWS  / 70 % history  (long range: lean on climatology)
 *
 * Result is clamped to [0.45, 0.90] so Kelly never over- or under-bets.
 */
function computeOurProb(
  hourlyTemps: number[],
  forecastTemp: number,
  daysAhead: number,
  histFreq: number | null
): number {
  // ── NWS signal ────────────────────────────────────────────────────────────
  const base = Math.max(0.45, 0.82 - daysAhead * 0.07);
  let nwsProb: number;

  if (hourlyTemps.length > 0) {
    const nearPeak  = hourlyTemps.filter((t) => Math.abs(t - forecastTemp) <= 3).length;
    const stability = nearPeak / hourlyTemps.length; // 0–1
    nwsProb = Math.max(0.45, Math.min(0.90, base * (0.70 + 0.30 * stability)));
  } else {
    nwsProb = Math.max(0.45, Math.min(0.90, base));
  }

  // ── Historical blend ──────────────────────────────────────────────────────
  if (histFreq == null) return nwsProb; // no history available — NWS only

  // histWeight rises linearly with horizon: 0.30 at day 0 → 0.70 at day 6
  const histWeight = Math.min(0.70, 0.30 + daysAhead * 0.067);
  const nwsWeight  = 1 - histWeight;

  const blended = nwsWeight * nwsProb + histWeight * histFreq;
  return Math.max(0.45, Math.min(0.90, blended));
}

/**
 * Kelly criterion for a binary prediction market:
 *   f* = (our_prob − price) / (1 − price)
 *
 * Returns 0 when there is no positive edge (i.e. our_prob ≤ price).
 */
function computeKellyPct(ourProb: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return Math.max(0, (ourProb - price) / (1 - price));
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface RunOptions {
  dryRun: boolean;
  config: BotConfig;
}

// ── showPositions ─────────────────────────────────────────────────────────────

export async function showPositions(): Promise<void> {
  const sim       = await loadSim();
  const positions = sim.positions;

  console.log(`\n${C.BOLD("📊 Open Positions:")}`);
  const mids = Object.keys(positions);
  if (!mids.length) {
    console.log("  No open positions");
    return;
  }

  let totalPnl = 0;
  for (const mid of mids) {
    const pos          = positions[mid];
    const currentPrice = (await getMarketYesPrice(mid)) ?? pos.entry_price ?? 0;
    const pnl          = (currentPrice - pos.entry_price) * pos.shares;
    totalPnl += pnl;

    const pnlStr = pnl >= 0
      ? C.GREEN(`+$${pnl.toFixed(2)}`)
      : C.RED(`-$${Math.abs(pnl).toFixed(2)}`);

    console.log(`\n  • ${pos.question.slice(0, 65)}...`);
    console.log(
      `    Entry: $${pos.entry_price.toFixed(3)} | Now: $${currentPrice.toFixed(3)} | ` +
      `Shares: ${pos.shares.toFixed(1)} | PnL: ${pnlStr}`
    );
    if (pos.kelly_pct != null) {
      console.log(
        `    Kelly: ${(pos.kelly_pct * 100).toFixed(1)}% | ` +
        `EV: ${pos.ev != null ? `$${pos.ev.toFixed(2)}` : "n/a"} | ` +
        `Our prob: ${pos.our_prob != null ? `${(pos.our_prob * 100).toFixed(0)}%` : "n/a"}`
      );
    }
    console.log(`    Cost: $${pos.cost.toFixed(2)}`);
  }

  console.log(`\n  Balance:      $${sim.balance.toFixed(2)}`);
  const pnlColor = totalPnl >= 0 ? C.GREEN : C.RED;
  console.log(
    `  Open PnL:     ${pnlColor(`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`)}`
  );
  console.log(
    `  Total trades: ${sim.total_trades} | W/L: ${sim.wins}/${sim.losses}`
  );
}

// ── run ───────────────────────────────────────────────────────────────────────

export async function run(options: RunOptions): Promise<void> {
  const { dryRun, config } = options;

  console.log(`\n${C.BOLD(C.CYAN("🌤  Weather Trading Bot v1 (TS)"))}`);
  console.log("=".repeat(50));

  const sim       = await loadSim();
  let   balance   = sim.balance;
  const positions = sim.positions;
  let   tradesExecuted = 0;
  let   exitsFound     = 0;

  const mode = dryRun
    ? `${C.YELLOW("PAPER MODE")}`
    : `${C.GREEN("LIVE MODE")}`;

  const starting    = sim.starting_balance;
  const totalReturn = ((balance - starting) / starting) * 100;
  const returnStr   = totalReturn >= 0
    ? C.GREEN(`+${totalReturn.toFixed(1)}%`)
    : C.RED(`${totalReturn.toFixed(1)}%`);

  const openCost  = Object.values(positions).reduce((s, p) => s + p.cost, 0);
  const openRisk  = balance > 0 ? openCost / balance : 0;

  // ── Header ───────────────────────────────────────────────────────────────
  console.log(`\n  Mode:            ${mode}`);
  console.log(
    `  Virtual balance: ${C.BOLD(`$${balance.toFixed(2)}`)} ` +
    `(started $${starting.toFixed(2)}, ${returnStr})`
  );
  console.log(
    `  Kelly fraction:  ${(config.kelly_fraction * 100).toFixed(0)}% | ` +
    `Max position:    ${(config.max_position_pct * 100).toFixed(0)}%`
  );
  console.log(
    `  Entry threshold: below $${config.entry_threshold.toFixed(2)} | ` +
    `Min edge: ${(config.min_edge * 100).toFixed(0)}%`
  );
  console.log(`  Exit threshold:  above $${config.exit_threshold.toFixed(2)}`);
  console.log(
    `  Open risk:       ${(openRisk * 100).toFixed(1)}% of balance ` +
    `(max ${(config.max_open_risk * 100).toFixed(0)}%)`
  );
  console.log(`  Trades W/L:      ${sim.wins}/${sim.losses}`);
  console.log(`  Days ahead:      ${config.days_ahead}`);

  // ── CHECK EXITS ───────────────────────────────────────────────────────────
  console.log(`\n${C.BOLD("📤 Checking exits...")}`);

  const today = new Date().toISOString().slice(0, 10);

  const closeExit = async (
    mid: string,
    pos: Position,
    exitPrice: number,
    label: string
  ): Promise<void> => {
    const pnl = (exitPrice - pos.entry_price) * pos.shares;
    exitsFound += 1;
    ok(`${label}: ${pos.question.slice(0, 50)}...`);
    info(
      `Exit price: $${exitPrice.toFixed(3)} | ` +
      `PnL: ${pnl >= 0 ? C.GREEN(`+$${pnl.toFixed(2)}`) : C.RED(`-$${Math.abs(pnl).toFixed(2)}`)}`
    );
    if (!dryRun) {
      balance += pos.cost + pnl;
      if (pnl > 0) sim.wins += 1; else sim.losses += 1;
      sim.trades.push({
        type: "exit", question: pos.question,
        entry_price: pos.entry_price, exit_price: exitPrice,
        pnl: Number(pnl.toFixed(2)), cost: pos.cost,
        closed_at: new Date().toISOString(),
        location: pos.location, date: pos.date,
        kelly_pct: pos.kelly_pct, ev: pos.ev, our_prob: pos.our_prob
      });
      delete positions[mid];
      ok(`Closed — PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
    } else {
      skip("Paper mode — not closing");
    }
  };

  for (const [mid, pos] of Object.entries(positions)) {
    const currentPrice = await getMarketYesPrice(mid);

    // ── Update live price on position for dashboard display ───────────────
    if (!dryRun && currentPrice != null) {
      pos.current_price = currentPrice;
    }

    // ── Resolution: market date is in the past ────────────────────────────
    // Price ≥ 0.95 = resolved YES (win). Price ≤ 0.05 or null = resolved NO (loss).
    if (pos.date && pos.date < today) {
      const resolvedPrice = currentPrice ?? 0;
      const won = resolvedPrice >= 0.95;
      const resultLabel = won ? C.GREEN("WIN ✅") : C.RED("LOSS ❌");
      await closeExit(mid, pos, resolvedPrice, `RESOLVED ${resultLabel}`);
      continue;
    }

    // ── Pre-close: sell 2 hours before market closes ──────────────────────
    if (pos.closes_at) {
      const hoursLeft = (new Date(pos.closes_at).getTime() - Date.now()) / 3_600_000;
      if (hoursLeft <= 2 && hoursLeft >= 0) {
        const exitPrice = currentPrice ?? pos.entry_price;
        await closeExit(mid, pos, exitPrice, `PRE-CLOSE (${hoursLeft.toFixed(1)}h left)`);
        continue;
      }
    }

    // ── Normal exit: price crossed threshold before resolution ────────────
    if (currentPrice == null) continue;

    if (currentPrice >= config.exit_threshold) {
      const holdHours = pos.opened_at
        ? (Date.now() - new Date(pos.opened_at).getTime()) / 3_600_000
        : null;
      const holdStr = holdHours != null ? ` | Held: ${holdHours.toFixed(0)}h` : "";
      info(`Price $${currentPrice.toFixed(3)} >= exit $${config.exit_threshold.toFixed(2)}${holdStr}`);
      await closeExit(mid, pos, currentPrice, "EXIT");
    }
  }

  if (exitsFound === 0) skip("No exit opportunities");

  // ── SCAN ENTRIES ──────────────────────────────────────────────────────────
  console.log(`\n${C.BOLD("🔍 Scanning for entry signals...")}`);

  // Global pre-checks before iterating locations
  const currentOpenRisk =
    balance > 0
      ? Object.values(positions).reduce((s, p) => s + p.cost, 0) / balance
      : 0;

  if (balance < config.min_balance_floor) {
    warn(
      `Balance $${balance.toFixed(2)} below floor $${config.min_balance_floor.toFixed(2)} — skipping all entries`
    );
  } else if (currentOpenRisk >= config.max_open_risk) {
    warn(
      `Open risk ${(currentOpenRisk * 100).toFixed(1)}% >= max ${(config.max_open_risk * 100).toFixed(0)}% — skipping all entries`
    );
  } else {
    const activeLocations = getActiveLocations(config);

    for (const citySlug of activeLocations) {
      if (!(citySlug in LOCATIONS)) continue;

      const locData = LOCATIONS[citySlug];

      // Single NWS call per city — returns both dailyMax and per-day hourly arrays
      const { dailyMax: forecast, hourlyByDate } = await getForecast(citySlug);

      // Fetch 3-year historical daily max temps (disk-cached 24 h, one call per city)
      const histData = await getHistoricalDailyMax(citySlug);
      if (!forecast || Object.keys(forecast).length === 0) continue;

      for (let i = 0; i < config.days_ahead; i++) {
        const date    = new Date();
        date.setDate(date.getDate() + i);
        const dateStr = date.toISOString().slice(0, 10);
        const month   = MONTHS[date.getMonth()];
        const day     = date.getDate();
        const year    = date.getFullYear();

        const forecastTemp = forecast[dateStr];
        if (forecastTemp == null) continue;

        const event: PolymarketEvent | null = await getPolymarketEvent(
          citySlug, month, day, year
        );
        if (!event) continue;

        const hoursLeft = hoursUntilResolution(event);

        console.log(`\n${C.BOLD(`📍 ${locData.name} — ${dateStr}`)}`);
        info(`Forecast: ${forecastTemp}°F | Resolves in: ${hoursLeft.toFixed(0)}h | Day +${i}`);

        if (hoursLeft < config.min_hours_to_resolution) {
          skip(`Resolves in ${hoursLeft.toFixed(0)}h — too soon`);
          continue;
        }

        // ── Find matching temperature bucket ────────────────────────────────
        let matched: {
          market:   PolymarketMarket;
          question: string;
          price:    number;
          range:    [number, number];
        } | null = null;

        for (const market of event.markets ?? []) {
          const question = market.question ?? "";
          const rng      = parseTempRange(question);
          // parseTempRange always returns °F-equivalent values.
          // forecastTemp is also in °F from Open-Meteo, so comparison is correct.
          if (rng && rng[0] <= forecastTemp && forecastTemp <= rng[1]) {
            try {
              const pricesStr = market.outcomePrices ?? "[0.5,0.5]";
              const prices    = JSON.parse(pricesStr) as number[];
              const yesPrice  = Number(prices[0]);
              if (!isFinite(yesPrice)) continue;
              matched = { market, question, price: yesPrice, range: rng };
            } catch {
              continue;
            }
            break;
          }
        }

        if (!matched) {
          skip(`No bucket found for ${forecastTemp}°F`);
          continue;
        }

        const price    = matched.price;
        const marketId = matched.market.id;
        const question = matched.question;

        // ── Volume filter ───────────────────────────────────────────────────
        const volume = matched.market.volume ?? 0;
        if (config.min_volume > 0 && volume < config.min_volume) {
          skip(`Volume $${volume.toFixed(0)} below min $${config.min_volume.toFixed(0)}`);
          continue;
        }

        // ── Historical climatology frequency ────────────────────────────────
        // How often did the daily max land in this exact bucket on the same
        // calendar period across the past 3 years? (±7-day window, Open-Meteo)
        const histFreq = historicalBucketFrequency(histData, dateStr, matched.range);

        // ── Kelly & probability computation ────────────────────────────────
        const hourlyTemps = hourlyByDate[dateStr] ?? [];
        const ourProb     = computeOurProb(hourlyTemps, forecastTemp, i, histFreq);
        const rawKelly    = computeKellyPct(ourProb, price);
        const kellyPct    = rawKelly * config.kelly_fraction;
        const positionPct = Math.min(kellyPct, config.max_position_pct);
        const edge        = ourProb - price;
        const positionSize = Number((balance * positionPct).toFixed(2));
        const ev          = Number((edge * positionSize).toFixed(2));

        const histFreqStr = histFreq != null
          ? `Hist freq: ${(histFreq * 100).toFixed(0)}% | `
          : `Hist freq: n/a | `;

        info(`Bucket: ${question.slice(0, 60)}`);
        info(`Market price: $${price.toFixed(3)}`);
        info(
          `${histFreqStr}` +
          `Our prob: ${(ourProb * 100).toFixed(0)}% | ` +
          `Edge: ${(edge * 100).toFixed(1)}% | ` +
          `Kelly: ${(rawKelly * 100).toFixed(1)}% → ${(positionPct * 100).toFixed(1)}% applied | ` +
          `EV: $${ev.toFixed(2)}`
        );

        // ── Entry threshold ─────────────────────────────────────────────────
        if (price >= config.entry_threshold) {
          skip(`Price $${price.toFixed(3)} above threshold $${config.entry_threshold.toFixed(2)}`);
          continue;
        }

        // ── Minimum edge gate ───────────────────────────────────────────────
        if (edge < config.min_edge) {
          skip(`Edge ${(edge * 100).toFixed(1)}% below min ${(config.min_edge * 100).toFixed(0)}%`);
          continue;
        }

        // ── Kelly yields no bet ─────────────────────────────────────────────
        if (positionPct <= 0) {
          skip("Kelly sizing yields zero — no positive edge");
          continue;
        }

        // ── Duplicate position ──────────────────────────────────────────────
        if (positions[marketId]) {
          skip("Already in this market");
          continue;
        }

        // ── Max trades per run ──────────────────────────────────────────────
        if (tradesExecuted >= config.max_trades_per_run) {
          skip(`Max trades (${config.max_trades_per_run}) reached`);
          continue;
        }

        // ── Min position size ───────────────────────────────────────────────
        if (positionSize < 0.5) {
          skip(`Position size $${positionSize.toFixed(2)} too small`);
          continue;
        }

        // ── Per-trade open-risk re-check (recalculated after each entry) ────
        const updatedOpenRisk =
          balance > 0
            ? Object.values(positions).reduce((s, p) => s + p.cost, 0) / balance
            : 0;
        if (updatedOpenRisk >= config.max_open_risk) {
          skip(
            `Open risk ${(updatedOpenRisk * 100).toFixed(1)}% would exceed ` +
            `${(config.max_open_risk * 100).toFixed(0)}%`
          );
          continue;
        }

        const shares = positionSize / price;

        ok(
          `SIGNAL — buying ${shares.toFixed(1)} shares @ $${price.toFixed(3)} = ` +
          `$${positionSize.toFixed(2)} (${(positionPct * 100).toFixed(1)}% Kelly)`
        );

        if (!dryRun) {
          balance -= positionSize;

          const pos: Position = {
            question,
            entry_price:   price,
            shares,
            cost:          positionSize,
            date:          dateStr,
            location:      citySlug,
            forecast_temp: forecastTemp,
            opened_at:     new Date().toISOString(),
            closes_at:     event.resolvedEndDate ?? undefined,
            current_price: price,
            // Analytics fields
            kelly_pct: Number(kellyPct.toFixed(4)),
            ev,
            our_prob:  Number(ourProb.toFixed(4))
          };
          positions[marketId] = pos;

          sim.total_trades += 1;

          const trade: Trade = {
            type:        "entry",
            question,
            entry_price: price,
            shares,
            cost:        positionSize,
            opened_at:   pos.opened_at,
            // Populate analytics fields on the trade record too
            kelly_pct: pos.kelly_pct,
            ev:        pos.ev,
            our_prob:  pos.our_prob,
            location:  citySlug,
            date:      dateStr
          };
          sim.trades.push(trade);
          tradesExecuted += 1;

          ok(`Position opened — $${positionSize.toFixed(2)} deducted from balance`);
        } else {
          skip("Paper mode — not buying");
          tradesExecuted += 1;
        }
      }
    }
  }

  // ── Save state ────────────────────────────────────────────────────────────
  if (!dryRun) {
    sim.balance      = Number(balance.toFixed(2));
    sim.positions    = positions;
    sim.peak_balance = Math.max(sim.peak_balance ?? balance, balance);
    await saveSim(sim);
    await appendDailyLog(sim);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`${C.BOLD("📊 Run Summary:")}`);
  info(`Balance:         $${balance.toFixed(2)}`);
  info(`Trades this run: ${tradesExecuted}`);
  info(`Exits found:     ${exitsFound}`);

  // Derived analytics — computed from existing sim data, no schema changes
  const analytics = computeAnalytics(sim);
  printAnalytics(analytics);

  if (dryRun) {
    console.log(
      `\n  ${C.YELLOW("[PAPER MODE — use --live to simulate trades]")}`
    );
  }
}
