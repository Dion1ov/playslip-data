/**
 * PlaySlip — Michigan draw results updater
 *
 * Runs on a schedule in GitHub Actions. Uses Playwright to drive the official
 * Michigan Lottery "Past Results" tool (the same export a person would click
 * through by hand), pulls the last 60 days for each daily-game stream, merges
 * the new draws into data/mi-draws.json, and commits only if something changed.
 *
 * Streams: d3m / d3e / d4m / d4e / d5m / d5e
 * (Daily 5 launched 2026-08-24, ahead of its announced Aug 28 date.)
 * Ball games: f5 / f5d / l47 / l47d from the same Michigan export, and
 * pb (Powerball) / mm (Mega Millions) full history from New York State
 * Open Data, stored as [date, "n,n,n,n,n+bonus"].
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = 'https://www.michiganlottery.com/resources/number-tools?SELECTED_TOOL=PAST_RESULTS&SELECTED_GAME=3';
const DATA_PATH = path.join(__dirname, 'data', 'mi-draws.json');
const LOOKBACK_DAYS = 60;

/**
 * Digit games: one stream per draw time. CSV = "Draw Date","Winning Numbers"
 */
const STREAMS = [
  { key: 'd3m', label: 'Daily 3 Midday' },
  { key: 'd3e', label: 'Daily 3 Evening' },
  { key: 'd4m', label: 'Daily 4 Midday' },
  { key: 'd4e', label: 'Daily 4 Evening' },
  // Daily 5 actually launched 2026-08-24, four days ahead of the announced
  // Aug 28 date. Enabled the same day so history accumulates from draw one.
  // If Michigan has not yet added it to the Past Results dropdown these two
  // log "FAILED" and are skipped — the per-stream try/catch below keeps
  // Daily 3 / Daily 4 unaffected. Harmless to leave enabled either way.
  { key: 'd5m', label: 'Daily 5 Midday' },
  { key: 'd5e', label: 'Daily 5 Evening' },
];

/**
 * Ball games: one export contains both Regular and Double Play drawings, split
 * by the "Drawing Type" column. CSV = "Draw Date","Winning Numbers","Drawing Type"
 */
const BALL_GAMES = [
  { label: 'Fantasy 5', regular: 'f5', double: 'f5d', size: 5 },
  { label: 'Lotto 47', regular: 'l47', double: 'l47d', size: 6 },
];


/**
 * Powerball and Mega Millions full history from New York State Open Data
 * (the national results). Small enough to pull whole every run, so it is
 * always complete and self-healing. Rows: [date, "n,n,n,n,n+bonus"], newest first.
 */
const NATIONAL = [
  { key: 'pb', url: 'https://data.ny.gov/resource/d6yy-54nr.json?$limit=50000&$order=draw_date%20DESC',
    parse: (r) => { const p = String(r.winning_numbers || '').trim().split(/\s+/).map(Number);
      return p.length >= 6 && !p.some(Number.isNaN) ? `${p.slice(0, 5).join(',')}+${p[5]}` : null; } },
  { key: 'mm', url: 'https://data.ny.gov/resource/5xaw-6ayf.json?$limit=50000&$order=draw_date%20DESC',
    parse: (r) => { const p = String(r.winning_numbers || '').trim().split(/\s+/).map(Number); const b = Number(r.mega_ball);
      return p.length >= 5 && !p.slice(0, 5).some(Number.isNaN) && !Number.isNaN(b) ? `${p.slice(0, 5).join(',')}+${b}` : null; } },
];

async function pullNational(data) {
  let added = 0;
  for (const g of NATIONAL) {
    try {
      const res = await fetch(g.url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json())
        .map((r) => [String(r.draw_date || '').slice(0, 10), g.parse(r)])
        .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[1]);
      if (rows.length < 100) throw new Error(`only ${rows.length} rows`);
      const existing = data.streams[g.key] || [];
      const before = new Set(existing.map((r) => `${r[0]}|${r[1]}`));
      const fresh = rows.filter((r) => !before.has(`${r[0]}|${r[1]}`)).length;
      if (fresh || existing.length !== rows.length) {
        data.streams[g.key] = rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
        added += fresh || 1;
        console.log(`${g.key}: ${rows.length} drawings (+${fresh} new)`);
      } else {
        console.log(`${g.key}: up to date (${rows.length})`);
      }
    } catch (err) {
      console.error(`${g.key}: FAILED — ${err.message}`);
    }
  }
  return added;
}

function fmt(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

/**
 * Same-day results.
 *
 * The Past Results export lags: it does not include the current day's drawings.
 * Verified Aug 6 2026 — the export ended at Aug 5 while Daily 3 had already
 * drawn 162 (midday) and 524 (evening) that day. A lottery app that's a day
 * behind is useless on the day it matters, so we also read each game's own
 * page, which posts results within minutes of the drawing.
 *
 * The export still does the heavy lifting (backfill, corrections). This pass
 * only adds today.
 */
const TODAY_PAGES = [
  { url: 'https://www.michiganlottery.com/games/daily-3', mid: 'd3m', eve: 'd3e', digits: 3 },
  { url: 'https://www.michiganlottery.com/games/daily-4', mid: 'd4m', eve: 'd4e', digits: 4 },
  { url: 'https://www.michiganlottery.com/games/daily-5', mid: 'd5m', eve: 'd5e', digits: 5 },
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** "Thu, Aug 6" → "2026-08-06", using Michigan's date to pick the year. */
function parseShownDate(text, nowET) {
  const m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\w{3})\w*\s+(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  let year = nowET.getFullYear();
  // Around New Year the page may still show December while we've ticked over.
  if (month === 11 && nowET.getMonth() === 0) year -= 1;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/**
 * Michigan's new site (Nov 23 2026). The old Past Results export and the old
 * game pages are gone (404 / no matching elements). The new Past Results page
 * lists the last 7 days for a game — today's drawings included, minutes after
 * they're drawn — as text:
 *
 *   Nov 23, 2026 · Midday            (digit games)
 *   7 / 3 / 5
 *   Winning numbers: 7, 3, 5
 *
 *   Nov 22, 2026                     (ball games)
 *   21 / 24 / …
 *   Regular Drawing                  (or Double Play Drawing)
 *   Winning numbers: 21, 24, 27, 28, 34
 *
 * Each row has a "Show payout table for <date>" button that opens a
 * "Midday Drawing" / "Evening Drawing" winners table (Win Conditions /
 * Winners / Prize), same columns as before.
 */
const PAST_URL = (slug) => `https://www.michiganlottery.com/number-tools?SELECTED_GAME=${slug}&SELECTED_TOOL=PAST_RESULTS`;
const DIGIT_GAMES = [
  { slug: 'daily-3', mid: 'd3m', eve: 'd3e', digits: 3 },
  { slug: 'daily-4', mid: 'd4m', eve: 'd4e', digits: 4 },
  { slug: 'daily-5', mid: 'd5m', eve: 'd5e', digits: 5 },
];
const BALL_SLUGS = { 'Fantasy 5': 'fantasy-5', 'Lotto 47': 'classic-lotto-47' };
const MONTH_IX = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** Page text → [{ date, time: 'midday'|'evening'|null, kind: 'regular'|'double'|null, nums: [..] }], newest first. */
function parsePastText(text) {
  const out = [];
  let date = null, time = null, kind = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const d = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),\s+(\d{4})(?:\s*[·•\-–]\s*(Midday|Evening))?$/i.exec(line);
    if (d) {
      const m = MONTH_IX[d[1].slice(0, 3)[0].toUpperCase() + d[1].slice(1, 3).toLowerCase()];
      date = `${d[3]}-${String(m).padStart(2, '0')}-${String(Number(d[2])).padStart(2, '0')}`;
      time = d[4] ? d[4].toLowerCase() : null;
      kind = null;
      continue;
    }
    if (/^Regular Drawing$/i.test(line)) { kind = 'regular'; continue; }
    if (/^Double Play Drawing$/i.test(line)) { kind = 'double'; continue; }
    const w = /^Winning numbers:\s*([\d,\s]+)$/i.exec(line);
    if (w && date) {
      out.push({ date, time, kind, nums: w[1].split(',').map((x) => x.trim()).filter(Boolean) });
      kind = null;
    }
  }
  return out;
}

/** Opens a game's Past Results page and returns its drawings (last 7 days). */
async function readPast(page, slug) {
  await page.goto(PAST_URL(slug), { waitUntil: 'domcontentloaded' });
  await page.getByText(/Winning numbers:/).first().waitFor({ timeout: 30000 });
  const text = await page.evaluate(() => (document.querySelector('main') || document.body).innerText);
  return parsePastText(text);
}

/**
 * Winners tables for the newest midday and newest evening drawing on the page
 * that readPast() just opened. Buttons are in the same order as the drawings.
 */
async function readWinners(page, draws) {
  const want = new Map();   // slot → index of its newest drawing
  draws.forEach((d, i) => { if (d.time && !want.has(d.time)) want.set(d.time, i); });
  const result = {};
  const buttons = page.getByRole('button', { name: /Show payout table for/i });
  for (const [slot, i] of want) {
    try {
      await buttons.nth(i).click();
      await page.waitForFunction((label) => [...document.querySelectorAll('main table')].some((t) => {
        let el = t;
        for (let k = 0; k < 6 && el; k++) { el = el.parentElement; if (el && new RegExp('^' + label + ' Drawing', 'm').test(el.innerText)) return true; }
        return false;
      }), slot === 'midday' ? 'Midday' : 'Evening', { timeout: 8000 });
      const tiers = await page.evaluate((label) => {
        for (const t of document.querySelectorAll('main table')) {
          let el = t, ok = false;
          for (let k = 0; k < 6 && el && !ok; k++) { el = el.parentElement; ok = !!el && new RegExp('^' + label + ' Drawing', 'm').test(el.innerText); }
          if (!ok) continue;
          const rows = [];
          for (const tr of [...t.querySelectorAll('tr')].slice(1)) {
            const c = [...tr.querySelectorAll('td,th')].map((x) => x.innerText.trim());
            if (c.length < 3 || !c[0] || c[1] === '') continue;
            const winners = Number(c[1].replace(/[^\d]/g, ''));
            const prize = Number(c[2].replace(/[^\d.]/g, ''));
            if (Number.isFinite(winners)) rows.push([c[0], winners, Number.isFinite(prize) ? prize : 0]);
          }
          return rows;
        }
        return null;
      }, slot === 'midday' ? 'Midday' : 'Evening');
      if (tiers && tiers.length) result[slot] = { date: draws[i].date, tiers };
      await buttons.nth(i).click().catch(() => {});   // close it again
    } catch (err) {
      console.log(`winners ${slot}: not read (${err.message.split('\n')[0]})`);
    }
  }
  return result;
}

/** Reads today's midday/evening digits off a game page. */
async function pullToday(page, cfg) {
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  return page.evaluate(() => {
    const out = { date: null, midday: null, evening: null };
    const dateEl = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 &&
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\w+\s+\d+$/.test(e.textContent.trim()),
    );
    out.date = dateEl ? dateEl.textContent.trim() : null;
    for (const key of ['midday', 'evening']) {
      const el = document.querySelector(`[aria-label*="${key} drawing results" i]`);
      if (!el) continue;
      // Text arrives as "162MID" / "6464EVE" — keep the leading digits only.
      const digits = (el.textContent.match(/^\d+/) || [])[0] || null;
      out[key] = digits;
    }

    // Winners per bet type. Each game page carries a "WIN CONDITIONS /
    // WINNERS / PRIZE" table for the midday and the evening drawing, under a
    // "The following are the results from: Monday, October 26th 2026" line.
    // Verified on Daily 3 / 4 / 5 pages 2026-10-27.
    out.winnersFrom = null;
    out.winners = { midday: null, evening: null };
    const rf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && /results from:/i.test(e.textContent),
    );
    if (rf) out.winnersFrom = rf.textContent.split(/results from:/i)[1].trim();
    for (const table of document.querySelectorAll('table')) {
      const head = ((table.querySelector('tr') || {}).innerText || '').toUpperCase();
      if (!head.includes('WINNERS')) continue;
      const labelEl = table.parentElement && table.parentElement.previousElementSibling;
      const label = ((labelEl && labelEl.textContent) || '').trim().toLowerCase();
      const slot = label.startsWith('midday') ? 'midday' : label.startsWith('evening') ? 'evening' : null;
      if (!slot) continue;
      const tiers = [];
      for (const tr of [...table.querySelectorAll('tr')].slice(1)) {
        const cells = [...tr.querySelectorAll('td,th')].map((c) => c.innerText.trim());
        if (cells.length < 3 || !cells[0]) continue;
        const winners = Number(cells[1].replace(/[^\d]/g, ''));
        const prize = Number(cells[2].replace(/[^\d.]/g, ''));
        if (!Number.isFinite(winners) || cells[1] === '') continue;
        tiers.push([cells[0], winners, Number.isFinite(prize) ? prize : 0]);
      }
      out.winners[slot] = tiers;
    }
    return out;
  });
}

/** "Monday, October 26th 2026" → "2026-10-26". */
function parseWinnersDate(text) {
  const m = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(text || '');
  if (!m) return null;
  const month = ['january','february','march','april','may','june','july','august','september','october','november','december']
    .indexOf(m[1].toLowerCase());
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** Digit games — digits stored with separators stripped ('9,0,2' → '902'). */
function parseCsv(csv) {
  const rows = [];
  for (const line of (csv || '').split('\n').slice(1)) {
    const m = line.match(/^"(\d\d)\/(\d\d)\/(\d{4})","([\d,]+)"/);
    if (!m) continue;
    rows.push([`${m[3]}-${m[1]}-${m[2]}`, m[4].replace(/,/g, '')]);
  }
  return rows;
}

/**
 * Ball games — numbers kept comma-separated, split by drawing type. `size`
 * drops rows with the wrong count: if the game dropdown doesn't switch in time
 * the export is still the previous game's, and from Sep 7 to Nov 7 2026 that
 * saved Fantasy 5 numbers into Lotto 47 (61 drawings, cleaned up below).
 */
function parseBallCsv(csv, size) {
  const regular = [];
  const double = [];
  for (const line of (csv || '').split('\n').slice(1)) {
    const m = line.match(/^"(\d\d)\/(\d\d)\/(\d{4})","([\d,]+)","([^"]*)"/);
    if (!m) continue;
    if (size && m[4].split(',').length !== size) continue;
    const row = [`${m[3]}-${m[1]}-${m[2]}`, m[4]];
    if (/DOUBLE/i.test(m[5])) double.push(row);
    else regular.push(row);
  }
  return { regular, double };
}

async function selectGame(page, label) {
  await page.evaluate(async (lbl) => {
    const sel = document.querySelector('input[id*="msl-dropdown"]');
    sel.focus();
    sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    const opt = [...document.querySelectorAll('[role="option"],[id*="-option-"]')]
      .find((o) => o.textContent.trim() === lbl);
    if (!opt) throw new Error('game option not found: ' + lbl);
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    opt.click();
  }, label);
  await page.waitForTimeout(1800);
}

async function pullRange(page, start, end) {
  return page.evaluate(async ({ start, end }) => {
    function setRV(el, v) {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const s = document.getElementById('startDateId');
    const e = document.getElementById('endDateId');
    s.focus(); setRV(s, start); s.blur();
    await new Promise((r) => setTimeout(r, 300));
    e.focus(); setRV(e, end); e.blur();
    await new Promise((r) => setTimeout(r, 400));
    [...document.querySelectorAll('button')].find((b) => /get results/i.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 12000));
    const dl = [...document.querySelectorAll('a')].find((x) => x.download && x.download.endsWith('.csv'));
    if (!dl) throw new Error('no CSV produced');
    return fetch(dl.href).then((r) => r.text());
  }, { start, end });
}

(async () => {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const today = new Date();
  const from = new Date(today.getTime() - LOOKBACK_DAYS * 86400000);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // The old export page (URL) is only opened by the by-hand backfills below.
  if (process.env.BACKFILL === '1' || process.env.DIGIT_BACKFILL === '1') {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
  }

  let added = 0;
  // Clean any ball-game rows with the wrong count of numbers (see parseBallCsv).
  for (const bg of BALL_GAMES) {
    for (const key of [bg.regular, bg.double]) {
      const rows = data.streams[key] || [];
      const keep = rows.filter((r) => String(r[1]).split(',').length === bg.size);
      if (keep.length !== rows.length) {
        console.log(`${key}: removed ${rows.length - keep.length} rows with the wrong count of numbers`);
        data.streams[key] = keep;
        added += rows.length - keep.length;
      }
    }
  }
  // ── Today's drawings, straight off each game page ──────────────────────────
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Detroit' }));
  let winnersChanged = false;
  async function sameDayPass() {
    for (const g of DIGIT_GAMES) {
      try {
        const draws = (await readPast(page, g.slug)).filter((d) => d.time && d.nums.length === g.digits);
        if (!draws.length) { console.log(`${g.mid}/${g.eve}: no drawings read from ${g.slug}`); continue; }
        for (const [slot, key] of [['midday', g.mid], ['evening', g.eve]]) {
          const fresh = draws.filter((d) => d.time === slot).map((d) => [d.date, d.nums.join('')]);
          const existing = data.streams[key] || [];
          const seen = new Set(existing.map((r) => `${r[0]}|${r[1]}`));
          const newRows = fresh.filter((r) => !seen.has(`${r[0]}|${r[1]}`));
          if (!newRows.length) continue;
          data.streams[key] = [...newRows, ...existing].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
          added += newRows.length;
          console.log(`${key}: +${newRows.length} (${newRows.map((r) => `${r[0]} ${r[1]}`).join(', ')})`);
        }
        // Winner counts — only the most recent drawing per stream is kept.
        // A table that totals 0 hasn't been tallied yet, so it never
        // overwrites the last real one.
        const won = await readWinners(page, draws);
        data.winners = data.winners || {};
        for (const [slot, key] of [['midday', g.mid], ['evening', g.eve]]) {
          const w = won[slot];
          if (!w) continue;
          const total = w.tiers.reduce((n, t) => n + t[1], 0);
          if (total === 0) continue;
          const prev = data.winners[key];
          const next = { date: w.date, total, tiers: w.tiers };
          if (prev && JSON.stringify(prev) === JSON.stringify(next)) continue;
          if (prev && prev.date > w.date) continue;
          data.winners[key] = next;
          winnersChanged = true;
          console.log(`${key}: winners for ${w.date} — ${total} total`);
        }
      } catch (err) {
        console.error(`${g.slug}: FAILED — ${err.message.split('\n')[0]}`);
      }
    }
  }


  // ── WATCH mode (dispatch with client_payload.watch) ─────────────────────────
  // Started right after a drawing. Skips the slow 60-day export and re-reads
  // the three game pages every 45 s until today's drawing (Daily 3 + Daily 4)
  // shows up, then saves at once — results land within a minute of Michigan
  // posting them instead of at the next 20-minute dispatch. Gives up after
  // 35 min; the regular backup dispatch still runs the full pass later.
  const WATCH = process.env.WATCH === '1';
  if (WATCH) {
    const todayISO = nowET.toLocaleDateString('en-CA');
    const slot = nowET.getHours() < 17 ? 'midday' : 'evening';
    const keys = slot === 'midday' ? ['d3m', 'd4m'] : ['d3e', 'd4e'];
    const have = () => keys.every((k) => (data.streams[k] || []).some((r) => r[0] === todayISO));
    const deadline = Date.now() + 35 * 60 * 1000;
    console.log(`WATCH: waiting for ${todayISO} ${slot}`);
    await sameDayPass();
    while (!have() && Date.now() < deadline) {
      await page.waitForTimeout(45000);
      await sameDayPass();
    }
    console.log(have() ? `WATCH: ${slot} found` : 'WATCH: gave up waiting');
  }

  if (!WATCH) {

  // ── Daily 3 / 4 / 5: the new Past Results page (last 7 days) ──────────────
  await sameDayPass();

  // ── Ball games (Fantasy 5, Lotto 47) ───────────────────────────────────────
  for (const bg of BALL_GAMES) {
    try {
      const draws = (await readPast(page, BALL_SLUGS[bg.label])).filter((d) => d.nums.length === bg.size);
      if (!draws.length) { console.log(`${bg.label}: no ${bg.size}-number drawings read — skipped`); continue; }
      const regular = draws.filter((d) => d.kind !== 'double').map((d) => [d.date, d.nums.map(Number).join(',')]);
      const double = draws.filter((d) => d.kind === 'double').map((d) => [d.date, d.nums.map(Number).join(',')]);
      for (const [key, fresh] of [[bg.regular, regular], [bg.double, double]]) {
        if (!fresh.length) continue;
        const existing = data.streams[key] || [];
        const seen = new Set(existing.map((r) => `${r[0]}|${r[1]}`));
        const newRows = fresh.filter((r) => !seen.has(`${r[0]}|${r[1]}`));
        if (newRows.length) {
          data.streams[key] = [...newRows, ...existing]
            .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
          added += newRows.length;
          console.log(`${key}: +${newRows.length} new`);
        } else {
          console.log(`${key}: up to date`);
        }
      }
    } catch (err) {
      console.error(`${bg.label}: FAILED — ${err.message.split('\n')[0]}`);
    }
  }

  // ── Daily 3 / Daily 4 history backfill (DIGIT_BACKFILL=1) ──────────────────
  // Run by hand: Actions → Update Michigan draw results → Run workflow →
  // backfill_digits = true. Pulls every year from DIGITS_FROM (default 1975)
  // through 2010 for Daily 3 and Daily 4, midday and evening. Three guards so
  // nothing lands in the wrong stream (the Lotto 47 lesson):
  //   1. the page must show the right game before each pull (re-selects once);
  //   2. rows must be the right length (3 or 4 digits) and from the year asked;
  //   3. 2010 is pulled again and compared with what we already have — the log
  //      prints MATCH or MISMATCH so the older years can be trusted.
  if (process.env.DIGIT_BACKFILL === '1') {
    const fromY = Number(process.env.DIGITS_FROM || 1975);
    // What the page says is selected — logged only. The real proof is the
    // 2010 gate below: a stream's older years are pulled only after its 2010
    // export matches, draw for draw, the 2010 we already have. A wrong game
    // (or midday/evening mix-up) can't pass that.
    const shownGame = () => page.evaluate(() => {
      const sv = document.querySelector('[class*="singleValue"], [class*="single-value"]');
      if (sv) return sv.textContent.trim();
      const m = document.body.innerText.match(/Select Game\s*\n\s*([^\n]+)/);
      return m ? m[1].trim() : '';
    });
    // The export leaves out its end date, so each year runs to Jan 1 of the
    // next and the year filter drops that extra day.
    const key2 = (r) => `${r[0]}|${r[1]}`;
    for (const stream of STREAMS.filter((s) => /^d[34]/.test(s.key))) {
      const len = stream.key.startsWith('d3') ? 3 : 4;
      const existing0 = data.streams[stream.key] || [];
      const have2010 = new Set(existing0.filter((r) => r[0].startsWith('2010-')).map(key2));
      let gated = false;
      for (let tries = 0; tries < 2 && !gated; tries++) {
        try {
          await selectGame(page, stream.label);
          const pulled = parseCsv(await pullRange(page, '01/01/2010', '01/01/2011'))
            .filter((r) => r[0].startsWith('2010-') && r[1].length === len);
          const same = pulled.filter((r) => have2010.has(key2(r))).length;
          gated = have2010.size > 300 && same === have2010.size && same === pulled.length;
          console.log(`DIGITS CHECK ${stream.key} 2010: ${gated ? 'MATCH' : 'MISMATCH'} (pulled ${pulled.length}, had ${have2010.size}, same ${same}; page shows "${await shownGame()}")`);
        } catch (err) {
          console.error(`DIGITS CHECK ${stream.key}: ${err.message}`);
        }
      }
      if (!gated) { console.error(`DIGITS ${stream.key}: 2010 did not match — skipped, nothing written`); continue; }
      for (let y = 2009; y >= fromY; y--) {
        try {
          const fresh = parseCsv(await pullRange(page, `01/01/${y}`, `01/01/${y + 1}`))
            .filter((r) => r[0].startsWith(`${y}-`) && r[1].length === len);
          const existing = data.streams[stream.key] || [];
          const seen = new Set(existing.map(key2));
          const newRows = fresh.filter((r) => !seen.has(key2(r)));
          if (newRows.length) {
            data.streams[stream.key] = [...existing, ...newRows].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
            added += newRows.length;
          }
          console.log(`DIGITS ${stream.key} ${y}: ${fresh.length} rows, +${newRows.length} new`);
        } catch (err) {
          console.log(`DIGITS ${stream.key} ${y}: none (${err.message})`);
        }
      }
    }
  }

  // ── Fantasy 5 / Lotto 47 history backfill (BACKFILL=1) ────────────────
  // Run by hand: Actions → Update Michigan draw results → Run workflow →
  // backfill = true. Same guards as the Daily 3/4 backfill: each game's 2010
  // export must match what we already have, draw for draw, before any older
  // year is written; each year runs to Jan 1 of the next (the export leaves out
  // its end date) and only rows from that year are kept. Then it walks back
  // from 2009 to BALL_FROM (default 1985). Safe to re-run.
  if (process.env.BACKFILL === '1') {
    const fromY = Number(process.env.BALL_FROM || 1985);
    const key2 = (r) => `${r[0]}|${r[1]}`;
    for (const bg of BALL_GAMES) {
      const have2010 = new Set((data.streams[bg.regular] || []).filter((r) => r[0].startsWith('2010-')).map(key2));
      let gated = false;
      for (let tries = 0; tries < 2 && !gated; tries++) {
        try {
          await selectGame(page, bg.label);
          const { regular } = parseBallCsv(await pullRange(page, '01/01/2010', '01/01/2011'), bg.size);
          const pulled = regular.filter((r) => r[0].startsWith('2010-'));
          const same = pulled.filter((r) => have2010.has(key2(r))).length;
          gated = have2010.size > 50 && same === have2010.size && same === pulled.length;
          console.log(`BACKFILL CHECK ${bg.regular} 2010: ${gated ? 'MATCH' : 'MISMATCH'} (pulled ${pulled.length}, had ${have2010.size}, same ${same})`);
        } catch (err) {
          console.error(`BACKFILL CHECK ${bg.label}: ${err.message}`);
        }
      }
      if (!gated) { console.error(`BACKFILL ${bg.label}: 2010 did not match — skipped, nothing written`); continue; }
      for (let y = 2009; y >= fromY; y--) {
        try {
          const { regular, double } = parseBallCsv(await pullRange(page, `01/01/${y}`, `01/01/${y + 1}`), bg.size);
          for (const [key, rows] of [[bg.regular, regular], [bg.double, double]]) {
            const fresh = rows.filter((r) => r[0].startsWith(`${y}-`));
            const existing = data.streams[key] || [];
            const seen = new Set(existing.map(key2));
            const newRows = fresh.filter((r) => !seen.has(key2(r)));
            if (newRows.length) {
              data.streams[key] = [...existing, ...newRows].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
              added += newRows.length;
            }
            if (fresh.length || key === bg.regular) console.log(`BACKFILL ${key} ${y}: ${fresh.length} rows, +${newRows.length} new`);
          }
        } catch (err) {
          console.log(`BACKFILL ${bg.label} ${y}: none (${err.message})`);
        }
      }
    }
  }

  }

  // Powerball / Mega Millions (not on the Michigan export). Skipped in watch
  // mode so the Daily 3/4 alert path stays fast.
  if (!WATCH) added += await pullNational(data);

  await browser.close();

  if (added === 0 && !winnersChanged) {
    console.log('No new draws or winner counts. Nothing to commit.');
    process.exit(0);
  }

  const newest = Object.values(data.streams)
    .map((rows) => (rows.length ? rows[0][0] : ''))
    .sort()
    .pop();

  // Stamp in Michigan time. The runner is UTC, so an evening run would
  // otherwise be dated tomorrow.
  data.generated = new Date()
    .toLocaleDateString('en-CA', { timeZone: 'America/Detroit' });
  data.coverage = `${['d3e', 'd3m', 'd4e', 'd4m'].map((k) => (data.streams[k] || []).slice(-1)[0]?.[0]).filter(Boolean).sort()[0] || '2010-01-01'} to ${newest}`;
  fs.writeFileSync(DATA_PATH, JSON.stringify(data));
  console.log(`Wrote ${added} new draws${winnersChanged ? ' + winner counts' : ''}. Latest draw: ${newest}`);
})().catch((err) => {
  console.error('Updater failed:', err);
  process.exit(1);
});
