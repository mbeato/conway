import { createMcpClient } from "../../shared/mcp";
import {
  getActiveApis,
  getApiRevenue,
  getErrorRate,
  getTotalRevenue,
  getRequestCount,
} from "../../shared/db";

export interface HealthReport {
  balanceUsd: number;
  creditsUsd: number;
  weeklyCostUsd: number;
  runwayWeeks: number;
  totalRevenue7d: number;
  apiReports: {
    name: string;
    revenue7d: number;
    requests7d: number;
    errorRate: number;
  }[];
}

// Estimated weekly cost (Conway terminal credits + server)
const ESTIMATED_WEEKLY_COST_USD = 0.50;

export async function monitor(): Promise<HealthReport> {
  console.log("[monitor] Checking health...");

  let balanceUsd = 0;
  let creditsUsd = 0;

  // Query wallet and credits via MCP
  try {
    const client = await createMcpClient(15_000);
    try {
      const balanceRaw = await client.getBalance();
      try {
        const balanceData = JSON.parse(balanceRaw);
        balanceUsd = balanceData.balance?.usdc ?? 0;
      } catch {
        const balanceMatch = balanceRaw.match(/(\d+\.?\d*)\s*(USDC|USD)/i);
        balanceUsd = balanceMatch ? parseFloat(balanceMatch[1]) : 0;
      }

      const creditsRaw = await client.getCredits();
      try {
        const creditsData = JSON.parse(creditsRaw);
        creditsUsd = (creditsData.credits_cents ?? 0) / 100;
      } catch {
        const creditsMatch = creditsRaw.match(/\$?(\d+\.?\d*)/);
        creditsUsd = creditsMatch ? parseFloat(creditsMatch[1]) : 0;
      }
    } finally {
      client.close();
    }
  } catch (e) {
    console.warn("[monitor] MCP client unavailable, using $0 for wallet/credits:", e);
  }

  // Revenue metrics
  const totalRev = getTotalRevenue(7);

  // Per-API metrics
  const apis = getActiveApis();
  const apiReports = apis.map((api) => ({
    name: api.name,
    revenue7d: getApiRevenue(api.name, 7),
    requests7d: getRequestCount(api.name, 7).count,
    errorRate: getErrorRate(api.name, 7).rate,
  }));

  const totalFunds = balanceUsd + creditsUsd;
  const runwayWeeks = ESTIMATED_WEEKLY_COST_USD > 0 ? totalFunds / ESTIMATED_WEEKLY_COST_USD : Infinity;

  const report: HealthReport = {
    balanceUsd,
    creditsUsd,
    weeklyCostUsd: ESTIMATED_WEEKLY_COST_USD,
    runwayWeeks,
    totalRevenue7d: totalRev.total_usd,
    apiReports,
  };

  // Log summary
  console.log("[monitor] --- Health Report ---");
  console.log(`  Wallet: $${balanceUsd.toFixed(2)} USDC`);
  console.log(`  Credits: $${creditsUsd.toFixed(2)}`);
  console.log(`  Runway: ${runwayWeeks.toFixed(1)} weeks`);
  console.log(`  Revenue (7d): $${totalRev.total_usd.toFixed(4)}`);
  for (const api of apiReports) {
    console.log(`  ${api.name}: $${api.revenue7d.toFixed(4)} rev, ${api.requests7d} reqs, ${(api.errorRate * 100).toFixed(1)}% errors`);
  }
  console.log("[monitor] --- End Report ---");

  return report;
}

// Run directly
if (import.meta.main) {
  const report = await monitor();
  console.log(JSON.stringify(report, null, 2));
}
