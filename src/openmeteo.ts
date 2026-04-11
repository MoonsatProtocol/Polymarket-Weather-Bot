/**
 * Open-Meteo Historical Weather Integration
 * https://github.com/open-meteo/open-meteo
 *
 * Fetches up to 3 years of daily maximum temperatures from the Open-Meteo
 * archive API (free, no API key required) and provides a helper to compute
 * the historical frequency of a temperature bucket around a given calendar date.
 *
 * Results are cached to disk (openmeteo-cache.json) for 24 hours so repeated
 * bot runs don't re-download multi-year datasets on every interval tick.
 */

import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { warn, info } from "./colors";
import { LOCATIONS } from "./nws";

// ── Constants ─────────────────────────────────────────────────────────────────

const ARCHIVE_BASE       = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_BASE      = "https://api.open-meteo.com/v1/forecast";
const CACHE_FILE         = path.resolve(__dirname, "..", "openmeteo-cache.json");
const CACHE_TTL_MS       = 24 * 60 * 60 * 1000; // 24 hours
const HISTORY_YEARS      = 3;
const REQUEST_TIMEOUT_MS = 20_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** date (YYYY-MM-DD) → daily max temperature in °F */
export type HistoricalDailyMax = Record<string, number>;

interface CacheEntry {
  fetched_at: string;
  data: HistoricalDailyMax;
}

type CacheStore = Record<string, CacheEntry>; // key: citySlug

// ── In-memory cache (avoid repeated disk reads within a single process run) ───
let memCache: CacheStore | null = null;

async function loadCache(): Promise<CacheStore> {
  if (memCache) return memCache;
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    memCache  = JSON.parse(raw) as CacheStore;
    return memCache;
  } catch {
    return {};
  }
}

async function saveCache(store: CacheStore): Promise<void> {
  memCache = store;
  await fs.writeFile(CACHE_FILE, JSON.stringify(store, null, 2), "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns 3 years of daily maximum temperatures (°F) for the given city,
 * fetched from the Open-Meteo archive API.
 *
 * Results are cached to disk for 24 hours per city slug. On failure, the
 * previous cached payload is returned as a graceful fallback.
 */
export async function getHistoricalDailyMax(
  citySlug: string
): Promise<HistoricalDailyMax> {
  const loc = LOCATIONS[citySlug];
  if (!loc) return {};

  const store   = await loadCache();
  const existing = store[citySlug];

  // Return cached data if still fresh
  if (existing) {
    const ageMs = Date.now() - new Date(existing.fetched_at).getTime();
    if (ageMs < CACHE_TTL_MS) {
      return existing.data;
    }
  }

  // Build date range: yesterday back 3 years
  // (archive API lags ~1-5 days; using yesterday is safe)
  const endDate   = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setFullYear(startDate.getFullYear() - HISTORY_YEARS);

  const start = startDate.toISOString().slice(0, 10);
  const end   = endDate.toISOString().slice(0, 10);

  const url =
    `${ARCHIVE_BASE}` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&start_date=${start}&end_date=${end}` +
    `&daily=temperature_2m_max` +
    `&temperature_unit=fahrenheit` +
    `&timezone=auto`;

  try {
    info(`Fetching Open-Meteo history for ${loc.name} (${start} → ${end})…`);
    const r      = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
    const times  = (r.data?.daily?.time                ?? []) as string[];
    const maxes  = (r.data?.daily?.temperature_2m_max  ?? []) as (number | null)[];

    const data: HistoricalDailyMax = {};
    for (let i = 0; i < times.length; i++) {
      const v = maxes[i];
      if (typeof v === "number") {
        data[times[i]] = Math.round(v * 10) / 10; // keep 1 decimal
      }
    }

    store[citySlug] = { fetched_at: new Date().toISOString(), data };
    await saveCache(store);
    return data;
  } catch (e) {
    warn(`Open-Meteo archive fetch failed for ${citySlug}: ${String(e)}`);
    // Fall back to stale cache if available
    return existing?.data ?? {};
  }
}

// ── Open-Meteo forecast (for non-NWS cities) ─────────────────────────────────

/**
 * Fetches an NWS-compatible ForecastData object for any city in the world
 * using the Open-Meteo forecast API.
 *
 * Used as a drop-in replacement for NWS getForecast() for international cities
 * that have no NWS coverage (Seoul, Shanghai, Tokyo, etc.).
 *
 * Returns the same ForecastData shape:
 *   { dailyMax: Record<date, °F>, hourlyByDate: Record<date, °F[]> }
 */
export async function getForecastFromOpenMeteo(
  citySlug: string,
  daysAhead = 7
): Promise<import("./nws").ForecastData> {
  const loc = LOCATIONS[citySlug];
  if (!loc) return { dailyMax: {}, hourlyByDate: {} };

  const url =
    `${FORECAST_BASE}` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&hourly=temperature_2m` +
    `&daily=temperature_2m_max` +
    `&temperature_unit=fahrenheit` +
    `&timezone=auto` +
    `&forecast_days=${daysAhead}`;

  const dailyMax:    import("./nws").DailyForecast        = {};
  const hourlyByDate: Record<string, number[]>            = {};

  try {
    const r = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });

    // ── Daily max (one value per day) ──────────────────────────────────────
    const dailyTimes = (r.data?.daily?.time                ?? []) as string[];
    const dailyMaxes = (r.data?.daily?.temperature_2m_max  ?? []) as (number | null)[];
    for (let i = 0; i < dailyTimes.length; i++) {
      const v = dailyMaxes[i];
      if (typeof v === "number") dailyMax[dailyTimes[i]] = Math.round(v * 10) / 10;
    }

    // ── Hourly temps (grouped by date for probability estimation) ──────────
    const hourlyTimes = (r.data?.hourly?.time          ?? []) as string[];
    const hourlyTemps = (r.data?.hourly?.temperature_2m ?? []) as (number | null)[];
    for (let i = 0; i < hourlyTimes.length; i++) {
      const dateStr = hourlyTimes[i].slice(0, 10);
      const v       = hourlyTemps[i];
      if (typeof v === "number") {
        if (!hourlyByDate[dateStr]) hourlyByDate[dateStr] = [];
        hourlyByDate[dateStr].push(Math.round(v * 10) / 10);
      }
    }
  } catch (e) {
    warn(`Open-Meteo forecast fetch failed for ${citySlug}: ${String(e)}`);
  }

  return { dailyMax, hourlyByDate };
}

// ── Historical frequency helper ───────────────────────────────────────────────

/**
 * Computes the fraction of historical days (within a ±windowDays calendar
 * window around the same day-of-year as `targetDate`, across all years in
 * `history`) where the daily maximum temperature fell inside `range`.
 *
 * Example: targetDate = "2026-04-15", range = [65, 67], windowDays = 7
 *   → looks at all dates Apr 8–22 across 2023/2024/2025
 *   → returns (days in [65, 67]) / (total matching days)
 *
 * Returns null when fewer than 5 matching data points are found (not enough
 * evidence to be useful; caller should fall back to NWS-only estimate).
 */
export function historicalBucketFrequency(
  history: HistoricalDailyMax,
  targetDate: string,
  range: [number, number],
  windowDays = 7
): number | null {
  const [lo, hi] = range;
  const targetDT = new Date(`${targetDate}T12:00:00Z`);

  /** Day-of-year (1–366) for a UTC date object */
  const dayOfYear = (d: Date): number => {
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((d.getTime() - jan1.getTime()) / 86_400_000) + 1;
  };

  const targetDOY = dayOfYear(targetDT);

  const matching: number[] = [];

  for (const [dateStr, temp] of Object.entries(history)) {
    const d   = new Date(`${dateStr}T12:00:00Z`);
    const doy = dayOfYear(d);

    // Circular distance on day-of-year (handles Dec/Jan boundary)
    let delta = Math.abs(doy - targetDOY);
    delta = Math.min(delta, 366 - delta);

    if (delta <= windowDays) {
      matching.push(temp);
    }
  }

  if (matching.length < 5) return null; // insufficient data

  const inBucket = matching.filter((t) => t >= lo && t <= hi).length;
  return inBucket / matching.length;
}
