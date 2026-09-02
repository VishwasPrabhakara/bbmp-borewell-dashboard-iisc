# Start here

## 1. View the dashboard locally (fastest)

Because the dashboard reads local JSON files, browsers block that on `file://` (a CORS restriction). Serve it over HTTP:

- **Windows**: double-click `start_server.bat`.
- **Or any terminal**:
  ```
  cd "C:\Users\ADMIN\OneDrive - Indian Institute of Science\Dashboard_IISC_for_BWSSB"
  python -m http.server 8000
  ```
  Then open <http://localhost:8000/>.

Leave the terminal open while you use the dashboard. Ctrl-C stops the server.

## 2. Publish it (professor-friendly URL, GitHub Pages)

Same pattern as your existing `bbmp-borewell-dashboard` repo: static site → GitHub Pages, auto-deployed by `.github/workflows/deploy.yml` on every push to `main`.

One-time setup:

```powershell
cd "C:\Users\ADMIN\OneDrive - Indian Institute of Science\Dashboard_IISC_for_BWSSB"
git init -b main
git add .
git commit -m "Initial dashboard (IISc for BWSSB)"

# Create the repo on GitHub (needs gh CLI; or create it via the website then push)
gh repo create bbmp-borewell-dashboard-iisc --public --source . --remote origin --push
```

If you don't use the `gh` CLI, create an empty repo on github.com first (e.g. `bbmp-borewell-dashboard-iisc`), then:

```
git remote add origin https://github.com/<your-user>/bbmp-borewell-dashboard-iisc.git
git push -u origin main
```

Then on github.com → the new repo → **Settings → Pages → Source: GitHub Actions**. Wait ~1 minute for the workflow to finish; the URL will be `https://<your-user>.github.io/bbmp-borewell-dashboard-iisc/`.

## 3. Refresh the data (when KH sends a new ZIP)

```
cd backend
pip install -r requirements.txt          # first time only
python sensors_db_extract.py             # optional but recommended (adds motor HP + all UIDs)
python prepare_data.py                    # rebuilds ../data/ from the KH ZIP + shapefile + population xlsx
cd ..
git add data && git commit -m "Refresh data snapshot" && git push
```

Push automatically triggers the deploy workflow. Live in ~1 minute.
