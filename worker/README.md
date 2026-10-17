# Live lookup proxy (Cloudflare Worker)

Lets the site look up any player live (rank, last 10 games, scoreboards) without putting the Riot key in the page.
The key is stored as a secret in Cloudflare and never leaves the worker.

## Setup (about 10 minutes, free)

1. Create a free account at https://dash.cloudflare.com/sign-up.
2. In the dashboard: **Workers & Pages → Create → Create Worker**. Name it `climb-race`, click **Deploy**.
3. Click **Edit code**, delete everything in the editor, paste the whole content of [`worker.js`](worker.js), click **Deploy**.
4. Go back to the worker → **Settings → Variables and Secrets → Add**: type **Secret**, name `RIOT_API_KEY`, value = your Riot key. Save/deploy.
5. Copy the worker's address (looks like `https://climb-race.YOURNAME.workers.dev`) and put it in `players.json`:
   `"proxy": "https://climb-race.YOURNAME.workers.dev"`. The site picks it up within a minute.

Check it works: open `https://climb-race.YOURNAME.workers.dev/player?id=Ymine%23000` in a browser; you should see JSON with a rank and games.

If you renew the Riot key, update it in both places: GitHub (RIOT_API_KEY secret) and here (step 4).

## Notes
- Answers are cached: a player for 10 minutes, a game for 7 days, so repeated clicks cost no Riot requests.
- One fresh lookup costs about 14 Riot requests, from the same 100-per-2-minutes allowance as the tracker.
- Only https://hoeschley.github.io is allowed to call it from a browser.
- Edit `src.js`, not `worker.js`, then run `node worker/build.mjs` (it copies in the site's rating code).
