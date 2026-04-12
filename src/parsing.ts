import { PolymarketEvent } from "./polymarket";

const cToF = (c: number): number => Math.round(c * 9 / 5 + 32);
const fToC = (f: number): number => Math.round((f - 32) * 5 / 9);

/**
 * Returns the temperature range from a Polymarket market question.
 * Always returns values in Fahrenheit for internal consistency.
 * Handles both °F questions (US cities) and °C questions (international cities).
 */
export function parseTempRange(
  question: string | undefined | null
): [number, number] | null {
  if (!question) return null;
  const q = question.toLowerCase();

  // ── Fahrenheit patterns ────────────────────────────────────────────────────
  if (q.includes("or below")) {
    const m = /(\d+)°f or below/i.exec(question);
    if (m) return [-999, parseInt(m[1], 10)];
  }
  if (q.includes("or higher")) {
    const m = /(\d+)°f or higher/i.exec(question);
    if (m) return [parseInt(m[1], 10), 999];
  }
  const mF = /between (\d+)-(\d+)°f/i.exec(question);
  if (mF) return [parseInt(mF[1], 10), parseInt(mF[2], 10)];

  // ── Celsius patterns (international cities) — convert to °F ───────────────
  if (q.includes("or below")) {
    const m = /(\d+)°c or below/i.exec(question);
    if (m) return [-999, cToF(parseInt(m[1], 10))];
  }
  if (q.includes("or higher")) {
    const m = /(\d+)°c or higher/i.exec(question);
    if (m) return [cToF(parseInt(m[1], 10)), 999];
  }
  const mC = /between (\d+)-(\d+)°c/i.exec(question);
  if (mC) return [cToF(parseInt(mC[1], 10)), cToF(parseInt(mC[2], 10))];

  return null;
}

/** Converts a forecast temperature to Celsius if the market question uses °C. */
export function marketUsesCelsius(question: string | undefined | null): boolean {
  if (!question) return false;
  return /°c/i.test(question);
}

/** Returns the forecast temp in the same unit the market question uses. */
export function forecastInMarketUnit(forecastF: number, question: string | undefined | null): number {
  return marketUsesCelsius(question) ? fToC(forecastF) : forecastF;
}

export function hoursUntilResolution(event: PolymarketEvent): number {
  try {
    const endDate = (event as any).endDate ?? (event as any).end_date_iso;
    if (!endDate) return 999;
    const iso = String(endDate).replace("Z", "+00:00");
    const endDt = new Date(iso);
    const now = new Date();
    const deltaHours = (endDt.getTime() - now.getTime()) / (1000 * 3600);
    return Math.max(0, deltaHours);
  } catch {
    return 999;
  }
}

