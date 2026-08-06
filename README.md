# PlaySlip Data Updater

Keeps Michigan Daily 3 / Daily 4 (and later Daily 5) results current so the
PlaySlip app doesn't need an App Store update every time a number falls.

## How it works

1. **GitHub Actions** runs `scrape.js` twice a day (after the midday and evening draws).
2. The script drives the official Michigan Lottery *Past Results* export with a
   headless browser — the same clicks a person would make — and pulls the last 60 days.
3. New draws are merged into `data/mi-draws.json` and committed.
4. The PlaySlip app fetches that file on launch and merges it with its bundled history.

Free to run. No server, no maintenance.

## One-time setup

This folder needs to live in its own **public** GitHub repo (public so the app
can read the file without any credentials — the data is public lottery results).

1. Create a new repo on GitHub named **playslip-data**, set to **Public**.
2. Copy this folder's contents into it:
   ```
   scrape.js
   data/mi-draws.json
   .github/workflows/update-draws.yml
   ```
3. Push it.
4. In the repo → **Settings → Actions → General → Workflow permissions**,
   select **Read and write permissions** and save. (This lets the bot commit.)
5. Go to the **Actions** tab → *Update Michigan draw results* → **Run workflow**
   to test it immediately instead of waiting for the schedule.

The app reads from:
```
https://raw.githubusercontent.com/Dion1ov/playslip-data/main/data/mi-draws.json
```
That URL is set in `lib/mi-history.ts` (`REMOTE_DATA_URL`). If you name the repo
something else, update that constant.

## When Daily 5 launches (Aug 28, 2026)

Open `scrape.js` and uncomment the `d5m` / `d5e` entries in the `STREAMS` array.
Then in the app, flip `live: true` for `daily5` in `lib/mi-history.ts`.

## If it ever breaks

The Michigan Lottery site could change its layout, which would break the script.
Symptoms: the Actions run fails, or the app's "last updated" date stops advancing.
The app keeps working on its bundled history either way — it just stops getting
fresh numbers until the script is fixed.
