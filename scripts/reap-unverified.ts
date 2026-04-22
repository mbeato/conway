#!/usr/bin/env bun
/**
 * Delete unverified users older than maxAgeHours along with dependent rows.
 * Safe to run repeatedly. Used by brain (daily) and as a standalone script.
 */
import db from "../shared/db";

export function reapUnverifiedUsers(maxAgeHours = 24, dryRun = false): number {
  const cutoff = `datetime('now', '-${Math.max(1, Math.floor(maxAgeHours))} hours')`;
  const victims = db
    .query(`SELECT id FROM users WHERE email_verified = 0 AND created_at < ${cutoff}`)
    .all() as { id: string }[];

  if (dryRun || victims.length === 0) return victims.length;

  const tx = db.transaction(() => {
    for (const { id } of victims) {
      db.run("DELETE FROM auth_events WHERE user_id = ?", [id]);
      db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
      db.run("DELETE FROM api_keys WHERE user_id = ?", [id]);
      db.run("DELETE FROM credit_transactions WHERE user_id = ?", [id]);
      db.run("DELETE FROM credit_balances WHERE user_id = ?", [id]);
      db.run("DELETE FROM verification_codes WHERE user_id = ?", [id]);
      db.run("DELETE FROM users WHERE id = ?", [id]);
    }
  });
  tx();
  return victims.length;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const hoursArg = args.find((a) => a.startsWith("--hours="));
  const hours = hoursArg ? Number(hoursArg.split("=")[1]) : 24;
  if (!Number.isFinite(hours) || hours < 1) {
    console.error(`invalid --hours value: ${hoursArg}`);
    process.exit(1);
  }
  const n = reapUnverifiedUsers(hours, dryRun);
  console.log(`[reap] ${dryRun ? "would delete" : "deleted"} ${n} unverified user(s) older than ${hours}h`);
}
