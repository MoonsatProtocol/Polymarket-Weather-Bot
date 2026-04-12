import fs from "fs/promises";
import path from "path";
import { ok } from "./colors";

const SIM_FILE = path.resolve(__dirname, "..", "simulation.json");
const SIM_BALANCE = 1000.0;

export interface Position {
  question: string;
  entry_price: number;
  shares: number;
  cost: number;
  date: string;
  location: string;
  forecast_temp: number;
  opened_at: string;
  // Optional fields used by dashboard v2
  pnl?: number;
  current_price?: number;
  closes_at?: string;       // ISO datetime when the market resolves — used for pre-close exit
  kelly_pct?: number;
  ev?: number;
  our_prob?: number;
}

export interface Trade {
  type: "entry" | "exit";
  question: string;
  entry_price: number;
  shares?: number;
  cost: number;
  opened_at?: string;
  exit_price?: number;
  pnl?: number;
  closed_at?: string;
  // Optional analytics fields
  kelly_pct?: number;
  ev?: number;
  our_prob?: number;
  location?: string;
  date?: string;
}

export interface SimulationState {
  balance: number;
  starting_balance: number;
  positions: Record<string, Position>;
  trades: Trade[];
  total_trades: number;
  wins: number;
  losses: number;
  peak_balance: number;
}

export async function loadSim(): Promise<SimulationState> {
  try {
    const raw = await fs.readFile(SIM_FILE, "utf8");
    return JSON.parse(raw) as SimulationState;
  } catch {
    return {
      balance: SIM_BALANCE,
      starting_balance: SIM_BALANCE,
      positions: {},
      trades: [],
      total_trades: 0,
      wins: 0,
      losses: 0,
      peak_balance: SIM_BALANCE
    };
  }
}

export async function saveSim(sim: SimulationState): Promise<void> {
  const data = JSON.stringify(sim, null, 2);
  await fs.writeFile(SIM_FILE, data, "utf8");
}

export async function resetSim(): Promise<void> {
  try {
    await fs.unlink(SIM_FILE);
  } catch {
    // ignore
  }
  ok(`Simulation reset — balance back to $${SIM_BALANCE.toFixed(2)}`);
}

