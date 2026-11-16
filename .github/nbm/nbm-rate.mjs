/**
 * NBM EUR / MDL — update the site's rate record (OWNER «AUTOMATIC NBM FX», 2026-11-16; supersedes the build-time constant of
 * «CALCULATOR CURRENCY R1»). The record is a static file the two calculators read when the page loads:
 *   source repository  public/data/nbm-eur-mdl.json   (the snapshot a build carries)
 *   production site    https://www.megaparc.md/data/nbm-eur-mdl.json   (kept current by the scheduled workflow of megaparc-md/megaparc-site,
 *                      .github/workflows/nbm-rate.yml, which runs a copy of this file and scripts/nbm-rate-core.mjs from .github/nbm/)
 * Rules: scripts/nbm-rate-core.mjs. Usage:
 *   node scripts/nbm-rate.mjs [--file public/data/nbm-eur-mdl.json] [--now 2026-11-16T09:00:00+02:00] [--base https://www.bnm.md] [--refresh] [--dry-run]
 *   node scripts/nbm-rate.mjs --date 2026-11-15      the official rate of one date (prints it, writes nothing)
 * Writes the file only when the record changes; on GitHub Actions also writes changed / date / rate / status / outcome to GITHUB_OUTPUT
 * and a line to the job summary. Exit 1 when the NBM answer is not accepted (someone should look) or when there is no record at all.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { check, fetchOfficial, isRecord, nbmDateOf } from "./nbm-rate-core.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const base = arg("base");

if (arg("date")) {
  const iso = arg("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error("--date YYYY-MM-DD");
  const r = await fetchOfficial(iso, { base });
  console.log(JSON.stringify({ date: iso, nbmDate: nbmDateOf(iso), ...r }));
  process.exitCode = r.kind === "ok" ? 0 : 1;
} else {
  await update();
}

// process.exitCode, never process.exit(): exiting while fetch sockets close aborts Node on Windows (UV_HANDLE_CLOSING)
async function update() {
  const file = arg("file") ?? "public/data/nbm-eur-mdl.json";
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (prev && !isRecord(prev)) { console.error(`NBM RATE: FAIL — ${file} is not a valid rate record`); process.exitCode = 1; return; }
  const now = arg("now") ? new Date(arg("now")) : new Date();
  // --refresh (the manual run of the workflow): today's confirmed rate is written again with the time of the confirmation
  const result = await check(prev, { now, base, refresh: process.argv.includes("--refresh") });
  for (const line of result.log) console.log(`  ${line}`);
  if (result.changed && !process.argv.includes("--dry-run")) writeFileSync(file, `${JSON.stringify(result.record, null, 2)}\n`);
  const r = result.record;
  const summary = `NBM RATE: ${result.outcome}${result.changed ? (process.argv.includes("--dry-run") ? " (would be written — dry run)" : " (written)") : ""} — ${r ? `1 EUR = ${r.rate} MDL · NBM ${nbmDateOf(r.date)} · status ${r.status}` : "no record"}`;
  console.log(summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\noutcome=${result.outcome}\ndate=${r?.date ?? ""}\nrate=${r?.rate ?? ""}\nstatus=${r?.status ?? ""}\nfetched=${r?.fetchedAt ?? ""}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n${result.log.map((l) => `- ${l}`).join("\n")}\n`);
  if (result.outcome === "unavailable" && process.env.GITHUB_ACTIONS) console.log(`::warning::NBM unreachable — the last valid rate (${r?.date}) stays`);
  process.exitCode = result.exitCode;
}
