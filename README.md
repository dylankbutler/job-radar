# Job Radar

A dashboard that refreshes itself on a schedule and scores roles against your background —
no browser tab needs to stay open, nothing runs on your machine.

## How it works

- `companies.txt` — your watchlist, one company per line
- `profile.txt` — your background/preferences, used to score and filter roles
- `scripts/refresh.mjs` — searches the web and scores roles against your profile, run headless
- `.github/workflows/refresh.yml` — runs that script daily via GitHub Actions and commits the results
- `data/jobs.json` — the results, written automatically
- `index.html` — the dashboard page, reads `data/jobs.json` — this is what you'll bookmark

## Setup (about 10 minutes, one time)

**1. Create a repo**
On github.com, create a new repository (public is simplest — Pages needs a public repo unless you're on a paid GitHub plan). Name it whatever you like, e.g. `job-radar`.

**2. Add these files**
Upload every file in this folder to that repo, keeping the folder structure intact (`.github/workflows/refresh.yml` needs to stay in that exact path). Easiest way: drag the whole folder into the GitHub web upload UI, or `git push` if you're comfortable with git.

**3. Add your API key as a secret**
In the repo: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `ANTHROPIC_API_KEY`
- Value: your key from the Anthropic Console

This keeps the key out of your code — the workflow reads it as an environment variable at run time.

**4. Turn on GitHub Pages**
In the repo: **Settings → Pages → Source: Deploy from a branch → Branch: main, folder: / (root) → Save**
GitHub will give you a URL like `https://yourusername.github.io/job-radar/` — that's your dashboard. Bookmark it.

**5. Run it once manually**
Don't wait for the daily schedule the first time. Go to the **Actions** tab → **Refresh Job Radar** workflow → **Run workflow** button. It takes a couple minutes. When it finishes, refresh your dashboard URL and you should see results.

**6. After that, it just runs**
Once a day (around 7-8am Pacific, adjustable in `refresh.yml` — it's a standard cron schedule), it searches, scores, and updates the page on its own. You just open the bookmark when you remember.

## Editing your watchlist or profile

Open `companies.txt` or `profile.txt` in the repo, click the pencil icon to edit, add/remove a line, commit. Changes take effect on the next run — trigger one manually from the Actions tab if you don't want to wait for the schedule.

## Notes

- Save (★) and dismiss on the dashboard are stored in your browser only (localStorage) — they won't sync across devices, but dismissed roles stay hidden on that browser going forward.
- Each scheduled run costs a small amount of API usage (a handful of web searches + short completions). Fully within normal personal-use range.
- If a run fails, check the Actions tab for the error log — most common cause is a missing or invalid `ANTHROPIC_API_KEY` secret.
