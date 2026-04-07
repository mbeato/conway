// scripts/brain/scout-config.ts
// Theme week configuration and demand source toggles.

import { join } from "path";

export interface ThemeWeek {
  enabled: boolean;
  category: string;
  description: string;
  start_date: string; // ISO date YYYY-MM-DD
  end_date: string;   // ISO date YYYY-MM-DD -- REQUIRED to prevent permanent lock-in
}

export interface DemandSources {
  dataforseo_enabled: boolean;
  autocomplete_fallback: boolean;
  rapidapi_enabled: boolean;
  devto_feedback_enabled: boolean;
}

export interface ScoutConfig {
  theme_week: ThemeWeek;
  demand_sources: DemandSources;
}

const CONFIG_PATH = join(import.meta.dir, "..", "..", "data", "scout-config.json");

const DEFAULTS: ScoutConfig = {
  theme_week: {
    enabled: false,
    category: "",
    description: "",
    start_date: "",
    end_date: "",
  },
  demand_sources: {
    dataforseo_enabled: true,
    autocomplete_fallback: true,
    rapidapi_enabled: true,
    devto_feedback_enabled: true,
  },
};

/**
 * Load scout configuration from data/scout-config.json.
 * Returns sensible defaults when the file doesn't exist or is malformed.
 * Uses Bun.file for async file reading per project conventions.
 */
export async function loadScoutConfig(): Promise<ScoutConfig> {
  try {
    const file = Bun.file(CONFIG_PATH);
    const text = await file.text();
    const parsed = JSON.parse(text);
    return {
      ...DEFAULTS,
      ...parsed,
      theme_week: { ...DEFAULTS.theme_week, ...parsed.theme_week },
      demand_sources: { ...DEFAULTS.demand_sources, ...parsed.demand_sources },
    };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Check if a theme week is currently active.
 * Returns false if disabled, missing dates, or current date is outside range.
 */
export function isThemeWeekActive(config: ScoutConfig, now: Date = new Date()): boolean {
  const tw = config.theme_week;
  if (!tw.enabled) return false;
  if (!tw.start_date || !tw.end_date) return false;
  const start = new Date(tw.start_date);
  const end = new Date(tw.end_date);
  return now >= start && now <= end;
}
