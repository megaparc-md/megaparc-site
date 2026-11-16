/**
 * NBM EUR / MDL — the logic of the automatic official rate (OWNER «AUTOMATIC NBM FX», 2026-11-16). Pure functions + one fetch helper;
 * no file system. Used by scripts/nbm-rate.mjs (by hand before a build, and by the scheduled GitHub Actions workflow of the production
 * repository megaparc-md/megaparc-site, which ships a copy of both files in .github/nbm/).
 *
 * THE OFFICIAL SOURCE — the XML export of the National Bank of Moldova:
 *   https://www.bnm.md/<en|ro>/official_exchange_rates?get_xml=1&date=DD.MM.YYYY
 *   <ValCurs Date="16.11.2026"> … <Valute><NumCode>978</NumCode><CharCode>EUR</CharCode><Nominal>1</Nominal><Value>20.1525</Value>
 * Facts checked on 2026-11-16: a weekend date answers with the rate in force on it (14 / 15.11 = the rate of Friday 13.11, each with its
 * own Date); a date not yet published answers 404.
 *
 * RULES
 *   · the rate of a date = the rate the NBM publishes FOR that date; "today" is the calendar date in Europe/Chisinau;
 *   · a rate is accepted only when two official exports (EN and RO) answer 200 with XML whose ValCurs Date is the requested date, one EUR
 *     row (NumCode 978) with a positive integer nominal and a decimal value, the two agree, the rate is plausible (10 – 40 MDL) and it
 *     moves less than 10 % against the last accepted rate; anything else is not accepted;
 *   · today not published yet (404) → the record keeps the last official rate with ITS date (the page names that date — it never calls
 *     an older rate today's); the two previous days are tried, so a missed weekend run is caught up with the rate in force on that date;
 *   · the NBM unreachable (network, 5xx, timeout) → the last valid rate stays, status «unavailable» with the time and the reason;
 *   · an answer that is not a valid official rate → the last valid rate stays, status «rejected» — the run fails so that someone looks;
 *   · nothing is ever invented: no rate without an accepted NBM answer.
 */
export const SCHEMA = "megaparc-nbm-rate/1";
export const TZ = "Europe/Chisinau";
export const NBM = "https://www.bnm.md";
const MAX_DAILY_MOVE = 0.1;

/** the calendar date in Chișinău, ISO (2026-11-16) — the date whose official rate is "today's" */
export function chisinauDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
/** ISO ± days, calendar arithmetic in UTC (no time-zone drift) */
export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** 2026-11-16 → 16.11.2026 (the NBM's own date format) */
export const nbmDateOf = (iso) => iso.split("-").reverse().join(".");
export const xmlUrl = (lang, iso, base = NBM) => `${base}/${lang}/official_exchange_rates?get_xml=1&date=${nbmDateOf(iso)}`;

/** the EUR rate of one official XML answer for the requested date — or why it is not one */
export function parseNbmXml(xml, iso) {
  if (typeof xml !== "string" || !/^\s*<\?xml/.test(xml) || !/<ValCurs\b/.test(xml)) return { ok: false, reason: "not an NBM XML document" };
  const date = (xml.match(/<ValCurs\b[^>]*\bDate="([^"]*)"/) ?? [])[1];
  if (date !== nbmDateOf(iso)) return { ok: false, reason: `ValCurs Date «${date ?? "—"}» ≠ the requested ${nbmDateOf(iso)}` };
  const rows = [...xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)].map((m) => m[1]).filter((row) => /<CharCode>\s*EUR\s*<\/CharCode>/.test(row));
  if (rows.length !== 1) return { ok: false, reason: `${rows.length} EUR rows` };
  const field = (name) => (rows[0].match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`)) ?? [])[1] ?? "";
  if (field("NumCode") !== "978") return { ok: false, reason: `EUR NumCode «${field("NumCode")}»` };
  const nominal = field("Nominal"), value = field("Value");
  if (!/^[1-9]\d*$/.test(nominal)) return { ok: false, reason: `EUR nominal «${nominal}»` };
  if (!/^\d{1,3}\.\d{1,6}$/.test(value)) return { ok: false, reason: `EUR value «${value}»` };
  const rate = Number(value) / Number(nominal);
  if (!(rate > 10 && rate < 40)) return { ok: false, reason: `implausible EUR rate ${rate}` };
  return { ok: true, rate: Math.round(rate * 1e6) / 1e6 };
}

/**
 * The official rate of one date from the NBM: two exports (EN, RO) must agree.
 * → { kind: "ok", rate, source } | { kind: "not-published" } | { kind: "unavailable", reason } | { kind: "invalid", reason }
 */
export async function fetchOfficial(iso, { fetchImpl = fetch, base = NBM, timeoutMs = 20000 } = {}) {
  const answers = [];
  for (const lang of ["en", "ro"]) {
    const url = xmlUrl(lang, iso, base);
    let res, body;
    try {
      res = await fetchImpl(url, { headers: { "user-agent": "MEGAPARC-rate-check (+https://www.megaparc.md)", accept: "application/xml,text/xml" }, signal: AbortSignal.timeout(timeoutMs) });
      body = await res.text();
    } catch (error) {
      return { kind: "unavailable", reason: `${lang}: ${error?.name === "TimeoutError" ? "timeout" : error?.message ?? "network error"}` };
    }
    if (res.status === 404) return { kind: "not-published" };
    if (res.status >= 500 || res.status === 429) return { kind: "unavailable", reason: `${lang}: HTTP ${res.status}` };
    if (res.status !== 200) return { kind: "invalid", reason: `${lang}: HTTP ${res.status}` };
    const parsed = parseNbmXml(body, iso);
    if (!parsed.ok) return { kind: "invalid", reason: `${lang}: ${parsed.reason}` };
    answers.push({ url, rate: parsed.rate });
  }
  if (answers[0].rate !== answers[1].rate) return { kind: "invalid", reason: `EN ${answers[0].rate} ≠ RO ${answers[1].rate}` };
  return { kind: "ok", rate: answers[0].rate, source: answers[0].url };
}

/** is this a record the site may show? (the page checks the same before it uses a fetched record) */
export function isRecord(r) {
  return !!r && r.schema === SCHEMA && r.base === "EUR" && r.quote === "MDL" && typeof r.rate === "number" && r.rate > 10 && r.rate < 40
    && /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "") && typeof r.source === "string" && r.source.startsWith(`${NBM}/`) && ["ok", "unavailable", "rejected"].includes(r.status);
}

const record = (rate, date, source, nowIso) => ({
  schema: SCHEMA, base: "EUR", quote: "MDL", rate, date, source, publisher: "Banca Națională a Moldovei (NBM)",
  fetchedAt: nowIso, status: "ok", statusAt: nowIso, note: null,
});

/**
 * One check: what the record becomes. → { record, changed, outcome, exitCode, log[] }
 *   outcome: "updated" · "unchanged" · "not-published" · "unavailable" · "rejected"
 */
export async function check(prev, { now = new Date(), fetchImpl, base, refresh = false } = {}) {
  const nowIso = now.toISOString();
  const today = chisinauDate(now);
  const log = [`today in ${TZ}: ${today}`, `record: ${prev ? `${prev.date} · ${prev.rate} · ${prev.status}` : "none"}`];
  if (prev && !isRecord(prev)) throw new Error("the current record is not a valid NBM record — refusing to build on it");
  // today's rate already held: every run confirms it against the NBM; a manual run (`refresh`) also writes the time of the confirmation
  if (prev && prev.date === today) {
    const r = await fetchOfficial(today, { fetchImpl, base });
    log.push(`NBM ${nbmDateOf(today)} (confirm): ${r.kind}${r.rate ? ` ${r.rate}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
    if (r.kind === "ok" && r.rate === prev.rate) {
      if (prev.status === "ok" && !refresh) return { record: prev, changed: false, outcome: "unchanged", exitCode: 0, log: [...log, "today's rate confirmed by the NBM"] };
      return { record: { ...prev, status: "ok", statusAt: nowIso, note: null, ...(refresh ? { fetchedAt: nowIso } : {}) }, changed: true, outcome: refresh ? "confirmed" : "updated", exitCode: 0, log };
    }
    if (r.kind === "invalid" || (r.kind === "ok" && Math.abs(r.rate / prev.rate - 1) > MAX_DAILY_MOVE)) {
      const reason = r.kind === "invalid" ? r.reason : `the rate ${r.rate} moves more than ${MAX_DAILY_MOVE * 100} % against ${prev.rate}`;
      const next = { ...prev, status: "rejected", statusAt: nowIso, note: `NBM answer not accepted: ${reason}` };
      return { record: next, changed: prev.status !== "rejected" || prev.note !== next.note, outcome: "rejected", exitCode: 1, log: [...log, `rejected: ${reason}`] };
    }
    // the NBM corrected today's rate: the corrected official rate replaces it
    if (r.kind === "ok") return { record: record(r.rate, today, r.source, nowIso), changed: true, outcome: "updated", exitCode: 0, log: [...log, `the NBM corrected the rate of ${nbmDateOf(today)}: ${prev.rate} → ${r.rate}`] };
    // unreachable or not answering for today: today's rate was accepted earlier and stays as it is
    return { record: prev, changed: false, outcome: r.kind === "unavailable" ? "unavailable" : "unchanged", exitCode: 0, log };
  }
  // today first; if it is not published yet, the two previous days (a missed run catches up with the rate in force on that date)
  for (const iso of [today, addDays(today, -1), addDays(today, -2)]) {
    if (prev && iso <= prev.date) break; // nothing newer to look for
    const r = await fetchOfficial(iso, { fetchImpl, base });
    log.push(`NBM ${nbmDateOf(iso)}: ${r.kind}${r.rate ? ` ${r.rate}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
    if (r.kind === "not-published") continue;
    if (r.kind === "unavailable") {
      if (!prev) return { record: null, changed: false, outcome: "unavailable", exitCode: 1, log };
      const next = prev.status === "unavailable" ? prev : { ...prev, status: "unavailable", statusAt: nowIso, note: `NBM unreachable: ${r.reason}` };
      return { record: next, changed: next !== prev, outcome: "unavailable", exitCode: 0, log };
    }
    if (r.kind === "invalid" || (prev && Math.abs(r.rate / prev.rate - 1) > MAX_DAILY_MOVE)) {
      const reason = r.kind === "invalid" ? r.reason : `the rate ${r.rate} moves more than ${MAX_DAILY_MOVE * 100} % against ${prev.rate}`;
      if (!prev) return { record: null, changed: false, outcome: "rejected", exitCode: 1, log: [...log, `rejected: ${reason}`] };
      const next = { ...prev, status: "rejected", statusAt: nowIso, note: `NBM answer not accepted: ${reason}` };
      return { record: next, changed: prev.status !== "rejected" || prev.note !== next.note, outcome: "rejected", exitCode: 1, log: [...log, `rejected: ${reason}`] };
    }
    const next = record(r.rate, iso, r.source, nowIso);
    return { record: next, changed: true, outcome: "updated", exitCode: 0, log };
  }
  // nothing newer published: the record stays as it is, with its own date (the page names it «последний опубликованный»)
  if (!prev) return { record: null, changed: false, outcome: "not-published", exitCode: 1, log };
  return { record: prev, changed: false, outcome: "not-published", exitCode: 0, log };
}
