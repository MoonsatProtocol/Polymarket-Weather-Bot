/** Wallet signature type: 0 = EOA, 1 = Polymarket proxy (Magic), 2 = Gnosis Safe */
export type SignatureType = 0 | 1 | 2;

export interface BotConfig {
  // ── Core thresholds ────────────────────────────────────────────────────────
  entry_threshold: number;
  exit_threshold: number;
  max_trades_per_run: number;
  min_hours_to_resolution: number;
  locations: string;

  // ── Wallet / auth ──────────────────────────────────────────────────────────
  polymarket_private_key: string;
  polymarket_proxy_wallet_address: string;
  /** Use proxy/safe wallet (funds at proxy address). If true, signature_type defaults to 2. */
  use_proxy_wallet: boolean;
  /** 0 = EOA, 1 = Polymarket proxy, 2 = Gnosis Safe. When use_proxy_wallet=true default is 2. */
  signature_type: SignatureType;

  // ── Kelly sizing ───────────────────────────────────────────────────────────
  /** Fractional Kelly multiplier applied to the raw Kelly % (e.g. 0.5 = half-Kelly). */
  kelly_fraction: number;
  /** Hard cap: never risk more than this fraction of balance on a single trade. */
  max_position_pct: number;
  /** Minimum required edge (our_prob − market_price) to open a position. */
  min_edge: number;

  // ── Risk controls ──────────────────────────────────────────────────────────
  /** Skip new entries when open positions already consume this fraction of balance. */
  max_open_risk: number;
  /** Do not open new positions when balance falls below this dollar amount. */
  min_balance_floor: number;

  // ── Market coverage ────────────────────────────────────────────────────────
  /** How many calendar days ahead to scan for markets (inclusive of today). */
  days_ahead: number;
  /** Skip markets whose total volume (USD) is below this value. 0 = no filter. */
  min_volume: number;

  // ── Telegram notifications ────────────────────────────────────────────────
  /** Bot token from @BotFather. Leave blank to disable notifications. */
  telegram_bot_token: string;
  /** Your Telegram chat ID. Get it by messaging your bot then calling getUpdates. */
  telegram_chat_id: string;
}

export const DEFAULT_CONFIG: BotConfig = {
  // Core
  entry_threshold:        0.15,
  exit_threshold:         0.45,
  max_trades_per_run:     5,
  min_hours_to_resolution: 2,
  locations:              "seoul,shanghai,wellington,tokyo,shenzhen,chengdu",
  // Wallet
  polymarket_private_key:            "",
  polymarket_proxy_wallet_address:   "",
  use_proxy_wallet:                  false,
  signature_type:                    0,
  // Kelly
  kelly_fraction:    0.5,
  max_position_pct:  0.20,
  min_edge:          0.05,
  // Risk
  max_open_risk:       0.40,
  min_balance_floor:   50,
  // Coverage
  days_ahead:  7,
  min_volume:  0,
  // Telegram
  telegram_bot_token: "",
  telegram_chat_id:   ""
};

export async function loadConfig(): Promise<BotConfig> {
  const parseNumber = (value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    // ── Core ──────────────────────────────────────────────────────────────
    entry_threshold: parseNumber(
      process.env.ENTRY_THRESHOLD,
      DEFAULT_CONFIG.entry_threshold
    ),
    exit_threshold: parseNumber(
      process.env.EXIT_THRESHOLD,
      DEFAULT_CONFIG.exit_threshold
    ),
    max_trades_per_run: parseNumber(
      process.env.MAX_TRADES_PER_RUN,
      DEFAULT_CONFIG.max_trades_per_run
    ),
    min_hours_to_resolution: parseNumber(
      process.env.MIN_HOURS_TO_RESOLUTION,
      DEFAULT_CONFIG.min_hours_to_resolution
    ),
    locations: process.env.LOCATIONS ?? DEFAULT_CONFIG.locations,

    // ── Wallet ─────────────────────────────────────────────────────────────
    polymarket_private_key:          process.env.POLYMARKET_PRIVATE_KEY ?? "",
    polymarket_proxy_wallet_address: process.env.POLYMARKET_PROXY_WALLET_ADDRESS ?? "",
    use_proxy_wallet:
      (process.env.USE_PROXY_WALLET ?? "").toLowerCase() === "true",
    signature_type: (() => {
      const raw = process.env.SIGNATURE_TYPE ?? "";
      if (raw === "1") return 1 as SignatureType;
      if (raw === "2") return 2 as SignatureType;
      return (process.env.USE_PROXY_WALLET ?? "").toLowerCase() === "true"
        ? (2 as SignatureType)
        : (0 as SignatureType);
    })(),

    // ── Kelly sizing ───────────────────────────────────────────────────────
    kelly_fraction:   parseNumber(process.env.KELLY_FRACTION,   DEFAULT_CONFIG.kelly_fraction),
    max_position_pct: parseNumber(process.env.MAX_POSITION_PCT, DEFAULT_CONFIG.max_position_pct),
    min_edge:         parseNumber(process.env.MIN_EDGE,         DEFAULT_CONFIG.min_edge),

    // ── Risk controls ──────────────────────────────────────────────────────
    max_open_risk:     parseNumber(process.env.MAX_OPEN_RISK,     DEFAULT_CONFIG.max_open_risk),
    min_balance_floor: parseNumber(process.env.MIN_BALANCE_FLOOR, DEFAULT_CONFIG.min_balance_floor),

    // ── Market coverage ────────────────────────────────────────────────────
    days_ahead: parseNumber(process.env.DAYS_AHEAD,  DEFAULT_CONFIG.days_ahead),
    min_volume: parseNumber(process.env.MIN_VOLUME,  DEFAULT_CONFIG.min_volume),

    // ── Telegram ───────────────────────────────────────────────────────────
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    telegram_chat_id:   process.env.TELEGRAM_CHAT_ID   ?? ""
  };
}

export function getActiveLocations(cfg: BotConfig): string[] {
  return cfg.locations
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
