import { monitor } from "./monitor";
import { scout } from "./scout";
import { build } from "./build";
import { list } from "./list";
import { prune } from "./prune";

const MIN_RUNWAY_WEEKS_SCOUT = 2;
const MIN_RUNWAY_WEEKS_BUILD = 4;
const MIN_CREDITS_FOR_BUILD = 0.5; // Need credits for GPT inference during code generation

async function main() {
  const timestamp = new Date().toISOString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[brain] Conway Brain starting at ${timestamp}`);
  console.log(`${"=".repeat(60)}\n`);

  // Step 1: Monitor — always runs first
  console.log("[brain] Step 1: Monitor");
  const health = await monitor();
  console.log(`[brain] Runway: ${health.runwayWeeks.toFixed(1)} weeks`);

  // Step 2: Scout — if we have runway
  if (health.runwayWeeks >= MIN_RUNWAY_WEEKS_SCOUT) {
    console.log("\n[brain] Step 2: Scout");
    await scout();
  } else {
    console.log(`\n[brain] Step 2: Scout SKIPPED — runway ${health.runwayWeeks.toFixed(1)}w < ${MIN_RUNWAY_WEEKS_SCOUT}w minimum`);
  }

  // Step 3: Build — if we have more runway, credits, and backlog items
  if (health.creditsUsd < MIN_CREDITS_FOR_BUILD) {
    console.log(`\n[brain] Step 3: Build SKIPPED — credits $${health.creditsUsd.toFixed(2)} < $${MIN_CREDITS_FOR_BUILD.toFixed(2)} minimum for inference`);
    console.log("[brain] Step 4: List SKIPPED — no build");
  } else if (health.runwayWeeks >= MIN_RUNWAY_WEEKS_BUILD) {
    console.log("\n[brain] Step 3: Build");
    const built = await build();
    if (built) {
      // Step 4: List — only if build succeeded
      console.log("\n[brain] Step 4: List");
      await list();
    } else {
      console.log("\n[brain] Step 4: List SKIPPED — no new API built");
    }
  } else {
    console.log(`\n[brain] Step 3: Build SKIPPED — runway ${health.runwayWeeks.toFixed(1)}w < ${MIN_RUNWAY_WEEKS_BUILD}w minimum`);
    console.log("[brain] Step 4: List SKIPPED — no build");
  }

  // Step 5: Prune — on Sundays
  const dayOfWeek = new Date().getDay();
  if (dayOfWeek === 0) {
    console.log("\n[brain] Step 5: Prune (Sunday)");
    await prune();
  } else {
    console.log("\n[brain] Step 5: Prune SKIPPED — not Sunday");
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[brain] Conway Brain finished at ${new Date().toISOString()}`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch((e) => {
  console.error("[brain] Fatal error:", e);
  Bun.exit(1);
});
