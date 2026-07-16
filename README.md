# Toronto Air Quality Dashboard (AQHI)

A static dashboard showing the **Air Quality Health Index (AQHI)** for Toronto and all of Ontario, using live data from Environment and Climate Change Canada. Runs entirely client-side — no server, no build step — so it deploys directly to GitHub Pages.

## What it shows

- **Current conditions** — latest AQHI for the selected station, risk category, and the official ECCC health messages, plus 24 h peak, next-24 h forecast peak, and a 24 h trend.

- **Forecast bulletin** — Today / Tonight / Tomorrow / Tomorrow Night AQHI forecast cards (including "in smoke" values when ECCC issues them).

- **Hourly timeline chart** — observed AQHI (solid) and hourly forecast (dashed) on one axis, with risk-category bands. 48 h / 72 h / 7-day history ranges, hover/keyboard tooltips, and a table view.

- **Ontario map** — every ECCC AQHI station from Windsor to Thunder Bay, colored by AQHI at the hour selected on the time scrubber (circles = observed, rounded squares = forecast), with play-through animation and an optional RAQDPS PM2.5 wildfire-smoke model overlay.

## Data sources

All data comes from the [MSC GeoMet](https://eccc-msc.github.io/open-data/msc-geomet/readme_en/) platform, which sends CORS headers (`Access-Control-Allow-Origin: *`), so the browser fetches it directly:

- `aqhi-stations` — station list (filtered to the Ontario administrative zone).

- `aqhi-observations-realtime` — hourly observed AQHI (the API retains ~3 days).

- `aqhi-forecasts-realtime` — hourly AQHI forecasts (~36–48 h ahead) and period bulletins. Note: this collection's `datetime` filter matches *publication* time, so the app sorts by newest publication and dedupes per station-hour client-side.

- GeoMet **WMS** `RAQDPS.SFC_PM2.5` — surface PM2.5 from the Regional Air Quality Deterministic Prediction System, used as the optional map overlay (hourly steps, ~72 h ahead).

- GeoMet **WMS GetFeatureInfo** on `RAQDPS.SFC_PM2.5` / `SFC_O3` / `SFC_NO2` — point-sampled at the selected station to compute an optional **model-estimated AQHI** (published AQHI formula, 3-hour rolling means) for hours beyond the official hourly forecast, out to the model's +72 h horizon. Clearly labeled "Model estimate" and drawn dotted: it is raw model guidance, not a forecaster product, so it can disagree with the period bulletin.

## Seven-day history

The realtime API only keeps ~3 days of observations. `.github/workflows/archive.yml` runs every 6 hours, fetches all Ontario observations with `scripts/update_archive.py` (stdlib only), and commits a rolling 9-day window to `data/archive/observations.json`. The app merges this archive with the live API, so the 7-day view fills in after the workflow has run for a few days.

## Deploying to GitHub Pages

1. Push this repository to GitHub.

2. In the repo: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**, branch `main`, folder `/ (root)`.

3. In **Settings → Actions → General**, ensure "Workflow permissions" allows **Read and write** (the archive workflow commits to the repo).

4. Optionally run the **Archive AQHI observations** workflow once by hand (Actions tab → Run workflow) to refresh the seeded archive.

Because Pages redeploys on every push, each archive commit also refreshes the published archive file automatically.

## Local development

```sh
python3 -m http.server 8741
# open http://localhost:8741
```

No dependencies to install; Leaflet loads from a CDN, everything else is vanilla ES modules.

## Notes

- Times display in the America/Toronto timezone; AQHI values above 10 are shown as "10+", per ECCC convention.

- AQHI colors are ECCC's official scale; every colored mark also carries its numeric value.

- Data is refreshed in the browser every 10 minutes.
