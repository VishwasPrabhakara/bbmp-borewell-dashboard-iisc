# Start here

Three things you'll want to do at some point: (1) view it locally, (2) publish to GitHub Pages, (3) refresh the data when KH sends a new ZIP. Optional (4): migrate to Cloudflare D1 for scale.

Read [README.md](./README.md) for the full picture of what's in this repo.

## 1. View the dashboard locally

Browsers block `file://` access to local JSON, so serve over HTTP:

- **Windows**: double-click `start_server.bat` — opens the browser to <http://localhost:8000/>.
- **Or any terminal**:
  ```
  cd "C:\Users\ADMIN\OneDrive - Indian Institute of Science\Dashboard_IISC_for_BWSSB"
  python -m http.server 8000
  ```
  Open <http://localhost:8000/>.

Ctrl-C stops the server.

## 2. Publish to GitHub Pages (professor-friendly URL)

Same pattern as `bbmp-borewell-dashboard`: static site + `.github/workflows/deploy.yml` runs on every push to `main`.

**One-time setup:**

```powershell
cd "C:\Users\ADMIN\OneDrive - Indian Institute of Science\Dashboard_IISC_for_BWSSB"
git init -b main
git add .
git commit -m "Initial dashboard (IISc for BWSSB)"

# Then either (a) gh CLI:
gh repo create bbmp-borewell-dashboard-iisc --public --source . --remote origin --push

# Or (b) plain git — first create an empty repo on github.com, then:
git remote add origin https://github.com/vishwasprabhakara/bbmp-borewell-dashboard-iisc.git
git push -u origin main
```

Then on the repo page → **Settings → Pages → Source: GitHub Actions**. Wait ~1 minute; the URL will be `https://<your-user>.github.io/bbmp-borewell-dashboard-iisc/`.

If the deploy fails in the Actions tab, click the failing step for the log and paste it back — usually it's just "Pages not enabled" and the fix is above.

## 3. Refresh the data (when KH sends a new ZIP)

From a machine with network access to Neon Postgres:

```
cd backend
pip install -r requirements.txt        # first time only
python sensors_db_extract.py           # optional; adds motor HP + full sensor list from your DB
python prepare_data.py                 # rebuilds ../data/*.json from the KH ZIP + shapefile + population xlsx
cd ..
git add data && git commit -m "Refresh data snapshot" && git push
```

Push triggers the deploy workflow. Live in ~1 minute.

See [backend/README.md](./backend/README.md) for env-var configuration, expected file locations, and step-by-step notes.

## 4. (Optional) Migrate to Cloudflare Worker + D1

You **don't need this yet** — the static site works fine at current scale. Do this when:

- Data grows beyond ~1 GB (GitHub Pages soft limit)
- You want the dashboard to answer live queries or accept writes
- You want data updates without redeploying the site

Full steps in [worker/README.md](./worker/README.md). Summary:

```
npm install -g wrangler && wrangler login
cd worker
wrangler d1 create bbmp-borewell-iisc          # copy the printed database_id into wrangler.toml
wrangler d1 execute bbmp-borewell-iisc --remote --file=schema.sql
python seed_d1.py                              # writes seed_generated/*.sql
# Run each of the generated .sql files with `wrangler d1 execute ... --file=...`
wrangler deploy                                # prints the Worker URL

# Then flip the switch in ../js/config.js:
#   window.DASHBOARD_CONFIG = { source: "api", apiBase: "https://bbmp-borewell-iisc.<sub>.workers.dev" };
git add js/config.js && git commit -m "Switch to D1 API" && git push
```

Everything stays on free tiers.

## Common issues

- **Dashboard shows a blank screen with all overlays open at once** — old cached CSS. Hard-refresh (Ctrl-Shift-R). The current CSS force-hides overlays with the `hidden` attribute.
- **Charts don't render** — Chart.js loads from CDN; if the professor's network blocks cdnjs, tell me and I'll bundle Chart.js locally.
- **`git push` prompts for password** — GitHub no longer accepts passwords. Use a personal access token: [Settings → Developer settings → Personal access tokens (classic)](https://github.com/settings/tokens) → generate one with `repo` scope → paste it when git asks.
