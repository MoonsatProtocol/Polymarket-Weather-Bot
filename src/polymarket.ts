import axios from "axios";
import { warn } from "./colors";

export interface PolymarketEvent {
  id: string;
  endDate?: string;
  end_date_iso?: string;
  markets?: PolymarketMarket[];
  [key: string]: any;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  outcomePrices?: string;
  /** Total volume traded on this market (USD). May be undefined on older API responses. */
  volume?: number;
  /** Current liquidity available on this market (USD). May be undefined on older API responses. */
  liquidity?: number;
  [key: string]: any;
}

export async function getPolymarketEvent(
  citySlug: string,
  month: string,
  day: number,
  year: number
): Promise<PolymarketEvent | null> {
  const slug = `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
  const url  = `https://gamma-api.polymarket.com/events?slug=${slug}`;
  try {
    const r    = await axios.get(url, { timeout: 10000 });
    const data = r.data;
    if (Array.isArray(data) && data.length > 0) {
      const event = data[0] as PolymarketEvent;
      // Hydrate volume/liquidity from nested markets if present at event level
      if (Array.isArray(event.markets)) {
        event.markets = event.markets.map((m: any) => ({
          ...m,
          volume:    typeof m.volume    === "number" ? m.volume    : parseFloat(m.volume    ?? "0") || 0,
          liquidity: typeof m.liquidity === "number" ? m.liquidity : parseFloat(m.liquidity ?? "0") || 0
        }));
      }
      return event;
    }
  } catch (e) {
    warn(`Polymarket API error: ${String(e)}`);
  }
  return null;
}

export async function getMarketYesPrice(marketId: string): Promise<number | null> {
  const url = `https://gamma-api.polymarket.com/markets/${marketId}`;
  try {
    const r          = await axios.get(url, { timeout: 5000 });
    const pricesStr  = r.data?.outcomePrices ?? "[0.5,0.5]";
    const prices     = JSON.parse(pricesStr) as number[];
    const currentPrice = Number(prices[0]);
    return isFinite(currentPrice) ? currentPrice : null;
  } catch {
    return null;
  }
}
