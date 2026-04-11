import axios from "axios";
import { warn, info } from "./colors";

export const LOCATIONS: Record<
  string,
  { lat: number; lon: number; name: string }
> = {
  // ── US cities (NWS + Open-Meteo) ──────────────────────────────────────────
  nyc:           { lat: 40.7772,  lon: -73.8726,   name: "New York City"  },
  chicago:       { lat: 41.9742,  lon: -87.9073,   name: "Chicago"        },
  miami:         { lat: 25.7959,  lon: -80.2870,   name: "Miami"          },
  dallas:        { lat: 32.8471,  lon: -96.8518,   name: "Dallas"         },
  seattle:       { lat: 47.4502,  lon: -122.3088,  name: "Seattle"        },
  atlanta:       { lat: 33.6407,  lon: -84.4277,   name: "Atlanta"        },
  denver:        { lat: 39.8561,  lon: -104.6737,  name: "Denver"         },
  boston:        { lat: 42.3606,  lon: -71.0097,   name: "Boston"         },
  phoenix:       { lat: 33.4373,  lon: -112.0078,  name: "Phoenix"        },
  minneapolis:   { lat: 44.8848,  lon: -93.2223,   name: "Minneapolis"    },
  las_vegas:     { lat: 36.0840,  lon: -115.1537,  name: "Las Vegas"      },
  san_francisco: { lat: 37.6188,  lon: -122.3750,  name: "San Francisco"  },
  los_angeles:   { lat: 33.9425,  lon: -118.4081,  name: "Los Angeles"    },
  portland:      { lat: 45.5898,  lon: -122.5951,  name: "Portland"       },
  // ── International cities (Open-Meteo forecast only — no NWS coverage) ─────
  seoul:         { lat: 37.5665,  lon: 126.9780,   name: "Seoul"          },
  shanghai:      { lat: 31.2304,  lon: 121.4737,   name: "Shanghai"       },
  wellington:    { lat: -41.2865, lon: 174.7762,   name: "Wellington"     },
  tokyo:         { lat: 35.6762,  lon: 139.6503,   name: "Tokyo"          },
  shenzhen:      { lat: 22.5431,  lon: 114.0579,   name: "Shenzhen"       },
  chengdu:       { lat: 30.5728,  lon: 104.0668,   name: "Chengdu"        }
};

export const NWS_ENDPOINTS: Record<string, string> = {
  nyc:           "https://api.weather.gov/gridpoints/OKX/37,39/forecast/hourly",
  chicago:       "https://api.weather.gov/gridpoints/LOT/66,77/forecast/hourly",
  miami:         "https://api.weather.gov/gridpoints/MFL/106,51/forecast/hourly",
  dallas:        "https://api.weather.gov/gridpoints/FWD/87,107/forecast/hourly",
  seattle:       "https://api.weather.gov/gridpoints/SEW/124,61/forecast/hourly",
  atlanta:       "https://api.weather.gov/gridpoints/FFC/50,82/forecast/hourly",
  denver:        "https://api.weather.gov/gridpoints/BOU/63,63/forecast/hourly",
  boston:        "https://api.weather.gov/gridpoints/BOX/71,90/forecast/hourly",
  phoenix:       "https://api.weather.gov/gridpoints/PSR/161,57/forecast/hourly",
  minneapolis:   "https://api.weather.gov/gridpoints/MPX/107,70/forecast/hourly",
  las_vegas:     "https://api.weather.gov/gridpoints/VEF/114,89/forecast/hourly",
  san_francisco: "https://api.weather.gov/gridpoints/MTR/85,83/forecast/hourly",
  los_angeles:   "https://api.weather.gov/gridpoints/LOX/150,48/forecast/hourly",
  portland:      "https://api.weather.gov/gridpoints/PQR/110,103/forecast/hourly"
};

export const STATION_IDS: Record<string, string> = {
  nyc:           "KLGA",
  chicago:       "KORD",
  miami:         "KMIA",
  dallas:        "KDAL",
  seattle:       "KSEA",
  atlanta:       "KATL",
  denver:        "KDEN",
  boston:        "KBOS",
  phoenix:       "KPHX",
  minneapolis:   "KMSP",
  las_vegas:     "KLAS",
  san_francisco: "KSFO",
  los_angeles:   "KLAX",
  portland:      "KPDX"
};

const USER_AGENT = "weatherbot-ts/1.0";

export type DailyForecast = Record<string, number>;

export interface ForecastData {
  /** Daily maximum temperature per date (YYYY-MM-DD → °F) */
  dailyMax: DailyForecast;
  /** All hourly temperatures per date — used for probability estimation */
  hourlyByDate: Record<string, number[]>;
}

export async function getForecast(citySlug: string): Promise<ForecastData> {
  // International cities have no NWS coverage — route to Open-Meteo forecast
  if (!NWS_ENDPOINTS[citySlug]) {
    info(`${citySlug}: no NWS coverage — using Open-Meteo forecast`);
    const { getForecastFromOpenMeteo } = await import("./openmeteo");
    return getForecastFromOpenMeteo(citySlug);
  }

  const forecastUrl = NWS_ENDPOINTS[citySlug];
  const stationId   = STATION_IDS[citySlug];
  const dailyMax: DailyForecast                = {};
  const hourlyByDate: Record<string, number[]> = {};
  const headers = { "User-Agent": USER_AGENT };

  // ── Real observations — what already happened today ─────────────────────
  try {
    const obsUrl = `https://api.weather.gov/stations/${stationId}/observations?limit=48`;
    const r = await axios.get(obsUrl, { timeout: 10000, headers });
    const features = (r.data?.features ?? []) as any[];
    for (const obs of features) {
      const props   = obs.properties ?? {};
      const timeStr = String(props.timestamp ?? "").slice(0, 10);
      const tempC   = props.temperature?.value as number | null | undefined;
      if (typeof tempC === "number") {
        const tempF = Math.round((tempC * 9) / 5 + 32);
        if (!(timeStr in dailyMax) || tempF > dailyMax[timeStr]) {
          dailyMax[timeStr] = tempF;
        }
        if (!hourlyByDate[timeStr]) hourlyByDate[timeStr] = [];
        hourlyByDate[timeStr].push(tempF);
      }
    }
  } catch (e) {
    warn(`Observations error for ${citySlug}: ${String(e)}`);
  }

  // ── Hourly forecast — upcoming hours ────────────────────────────────────
  try {
    const r       = await axios.get(forecastUrl, { timeout: 10000, headers });
    const periods = r.data?.properties?.periods ?? [];
    for (const p of periods as any[]) {
      const date = String(p.startTime ?? "").slice(0, 10);
      let temp   = p.temperature as number;
      if (p.temperatureUnit === "C") {
        temp = Math.round((temp * 9) / 5 + 32);
      }
      if (!(date in dailyMax) || temp > dailyMax[date]) {
        dailyMax[date] = temp;
      }
      if (!hourlyByDate[date]) hourlyByDate[date] = [];
      hourlyByDate[date].push(temp);
    }
  } catch (e) {
    warn(`Forecast error for ${citySlug}: ${String(e)}`);
  }

  return { dailyMax, hourlyByDate };
}
