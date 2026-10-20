# Working preferences

- The user runs downloads and analysis themselves. Edit source code, tests, and project instructions. Perform filesystem cleanup when explicitly requested. Do not execute downloaders, data conversions, database builds, analysis, or tests unless the user explicitly asks you to run them.
- Sportmonks is the primary football data provider. TFF Fantasy statistics may be kept as a separate supplemental CSV source. Do not add API-Football code or credentials.
- Use Sportmonks player IDs as cross-provider player keys. Never auto-assign ambiguous name matches; write a review report and require an explicit override.
- Keep CSV as the analysis/exchange format, including caches and reports. SQLite is allowed for the final structured dataset and SQL queries. Do not create duplicate JSON exports or JSON-encoded CSV cells.
- JSON parsing is allowed only in memory to decode provider HTTP responses.
- Do not delete or convert previously downloaded files without an explicit request.
- Keep API credentials local and never print their values.
- Keep lossless provider captures under `data/raw`, rebuildable caches and reports under `data/temp`, and website-ready CSVs under `data/final`.
- Keep the unified SQLite database at `data/superlig.sqlite`. Preserve reviewed identity overrides under `config/`; they are not temporary data.
- The public site (fantezianaliz.com, Cloudflare Pages) is the files-only build that `src/web/build_static.py` writes to `data/temp/site`. Anything that needs `src/web/serve.py` at request time, such as live scores or Kadro Kur recommendations, must stay off unless `siteMode` (in `src/web/core/site.js`) is `"local"`. Never publish `.env`, `data/raw`, or `assets/face-portraits/`.
- Fantasy scoring rules live in `config/tff_scoring_rules.csv`. They are transcribed from a supplied rules graphic, not from a provider feed, so treat them as reviewed reference data: change them only when the user supplies a new source, and keep the `needs_confirmation` flag honest.
