/**
 * PlaySlip — Michigan draw results updater
 *
 * Runs on a schedule in GitHub Actions. Uses Playwright to drive the official
 * Michigan Lottery "Past Results" tool (the same export a person would click
 * through by hand), pulls the last 60 days for each daily-game stream, merges
 * the new draws into data/mi-draws.json, and commits only if something changed.
 *
 * Streams: d3m / d3e / d4m / d4e  (+ d5m / d5e once Daily 5 launches Aug 28, 2026)
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
  // Daily 5 launches 2026-08-28. Uncomment once the game appears in the dropdown.
  // { key: 'd5m', label: 'Daily 5 Midday' },
  // { key: 'd5e', label: 'Daily 5 Evening' },
];

/**
 * Ball games: one export contains both Regular and Double Play drawings, split
 * by the "Drawing Type" column. CSV = "Draw Date","Winning Numbers","Drawing Type"
 */
const BALL_GAMES = [
  { label: 'Fantasy 5', regular: 'f5', double: 'f5d' },
  { label: 'Lotto 47', regular: 'l47', double: 'l47d' },
];

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
    return out;
  });
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

/** Ball games — numbers kept comma-separated, split by drawing type. */
function parseBallCsv(csv) {
  const regular = [];
  const double = [];
  for (const line of (csv || '').split('\n').slice(1)) {
    const m = line.match(/^"(\d\d)\/(\d\d)\/(\d{4})","([\d,]+)","([^"]*)"/);
    if (!m) continue;
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
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  let added = 0;

  for (const stream of STREAMS) {
    try {
      await selectGame(page, stream.label);
      const csv = await pullRange(page, fmt(from), fmt(today));
      const fresh = parseCsv(csv);
      if (!fresh.length) {
        console.log(`${stream.key}: no rows returned`);
        continue;
      }

      const existing = data.streams[stream.key] || [];
      // Key on date + digits so twice-daily bonus draws aren't lost
      const seen = new Set(existing.map((r) => `${r[0]}|${r[1]}`));
      const newRows = fresh.filter((r) => !seen.has(`${r[0]}|${r[1]}`));

      if (newRows.length) {
        const merged = [...newRows, ...existing].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
        data.streams[stream.key] = merged;
        added += newRows.length;
        console.log(`${stream.key}: +${newRows.length} new (${newRows.map((r) => r[0]).join(', ')})`);
      } else {
        console.log(`${stream.key}: up to date`);
      }
    } catch (err) {
      // One stream failing must not abandon the others
      console.error(`${stream.key}: FAILED — ${err.message}`);
    }
  }

  // ── Ball games (Fantasy 5, Lotto 47) ───────────────────────────────────────
  for (const bg of BALL_GAMES) {
    try {
      await selectGame(page, bg.label);
      const csv = await pullRange(page, fmt(from), fmt(today));
      const { regular, double } = parseBallCsv(csv);

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
      console.error(`${bg.label}: FAILED — ${err.message}`);
    }
  }

  // ── Today's drawings, straight off each game page ──────────────────────────
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Detroit' }));
  for (const cfg of TODAY_PAGES) {
    try {
      const today = await pullToday(page, cfg);
      const dateISO = today.date ? parseShownDate(today.date, nowET) : null;
      if (!dateISO) {
        console.log(`${cfg.mid}/${cfg.eve}: could not read today's date ("${today.date}")`);
        continue;
      }

      for (const [slot, key] of [['midday', cfg.mid], ['evening', cfg.eve]]) {
        const digits = today[slot];
        // "Results Pending" before a drawing — nothing to record yet.
        if (!digits || digits.length !== cfg.digits) continue;

        const existing = data.streams[key] || [];
        if (existing.some((r) => r[0] === dateISO)) continue;

        data.streams[key] = [[dateISO, digits], ...existing];
        added += 1;
        console.log(`${key}: +1 from game page (${dateISO} ${digits})`);
      }
    } catch (err) {
      // Best effort — the export pass already ran, so this never blocks a commit.
      console.error(`${cfg.url}: same-day pass failed — ${err.message}`);
    }
  }

  await browser.close();

  if (added === 0) {
    console.log('No new draws. Nothing to commit.');
    process.exit(0);
  }

  const newest = Object.values(data.streams)
    .map((rows) => (rows.length ? rows[0][0] : ''))
    .sort()
    .pop();

  data.generated = new Date().toISOString().slice(0, 10);
  data.coverage = `2010-01-01 to ${newest}`;
  fs.writeFileSync(DATA_PATH, JSON.stringify(data));
  console.log(`Wrote ${added} new draws. Latest draw: ${newest}`);
})().catch((err) => {
  console.error('Updater failed:', err);
  process.exit(1);
});
