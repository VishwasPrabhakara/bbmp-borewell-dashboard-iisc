/**
 * Dashboard data source config.
 *
 * source: "static"  -> read data/*.json shipped with the site (default)
 *         "api"     -> read from a Cloudflare Worker + D1 (production scaling path)
 * apiBase: only used when source === "api". Fill in the URL wrangler printed
 *          after `wrangler deploy`, e.g. https://bbmp-borewell-iisc.username.workers.dev
 *
 * To switch to the Worker: set source to "api" and paste your apiBase, commit + push.
 */
window.DASHBOARD_CONFIG = {
  source: "static",
  apiBase: "",
};
