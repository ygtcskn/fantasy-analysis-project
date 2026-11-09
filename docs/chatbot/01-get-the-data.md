# Step 1 — Get the data

Your website's data lives in Cloudflare R2 (cloud storage). GitHub Actions
updates it every hour. To build the chatbot you need a copy on your computer.

## 1. Create `.env`

`.env` holds your passwords for this computer only.

1. **Copy** `.env.example` and name the copy `.env`. Copy it; don't rename
   the original.
2. Fill in the four R2 lines (from Cloudflare → R2 → Manage API tokens):
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=fantezianaliz-data`.

> ⚠️ **Lesson learned:** renaming `.env.example` in an editor can also
> "helpfully" rename it inside `.gitignore`, which stops git from ignoring
> `.env`. Check it is still ignored:
>
> ```bash
> git check-ignore -v .env
> ```
>
> It should print a line ending in `.env`. If it prints nothing, **stop** and
> fix `.gitignore` before any `git add`.

## 2. Install the downloader's helper

```bash
pip install boto3
```

## 3. Download

Preview first (changes nothing):

```bash
python src/sync_data.py pull --dry-run
```

Then the real download:

```bash
python src/sync_data.py pull
```

**What it does:** it lists `data/final` and `data/temp/site_update` in R2 and
downloads every file you don't already have. It never deletes anything and
never changes R2 or the website.

## ✅ You're done when

The folder `data/final/sportmonks/` contains one folder per season
(`2021-2022` … `2026-2027`), each with `fixtures.csv`, `events.csv`,
`player_match_stats.csv` and so on.

Next: [Step 2 — Build the database](02-build-the-database.md)
