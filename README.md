# Solo/Duo Climb Race

A leaderboard for a Ranked Solo/Duo climbing competition between friends. A GitHub Action calls the Riot API every 10 minutes and saves `data.json`; GitHub Pages shows the leaderboard at a public link.

## Setup (about 10 minutes)

1. **Create the repository.** On github.com, click **New repository**, name it `climb-race`, set it to **Public** (required for free GitHub Pages), and create it.
2. **Upload the files.** Click **uploading an existing file**, then drag in everything from this folder, including the `.github` folder. If your file browser hides `.github`, create the file manually in GitHub: **Add file → Create new file**, name it `.github/workflows/update.yml`, and paste its contents.
3. **Add the players.** Edit `players.json` on GitHub:
   - `riotId`: each player's Riot ID exactly as shown in the client, e.g. `Faker#KR1`.
   - `start` (optional): their rank on October 1. Tier in capitals (`GOLD`), division as a Roman numeral (`II`), LP as a number. Leave `start` out and the first rank the script sees becomes the baseline.
   - Players on another server: change `platform` (`euw1`, `eun1`, `na1`…) and `region` (`europe`, `americas`, `asia`).
4. **Add the API key as a secret.** Go to **Settings → Secrets and variables → Actions → New repository secret**. Name: `RIOT_API_KEY`. Value: your key. Never put the key in any file.
5. **Turn on the website.** Go to **Settings → Pages**, under Source pick **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
6. **Run the first update.** Go to the **Actions** tab, enable workflows if asked, open **Update standings**, and click **Run workflow**. After a minute or two, `data.json` appears in the repo.

The site is then live at `https://YOUR-USERNAME.github.io/climb-race/`. Share that link; nobody needs an account to view it.

## Adding or removing a player

Edit `players.json` on GitHub (pencil icon), then **Commit changes**. Each player is one line.

- **Add:** copy a line and change the Riot ID, keeping the comma between lines:
  `{ "riotId": "NewFriend#EUW" },`
  Without a `start`, their race starts from the rank they have when the next update runs. To give them a starting rank, write it like the others:
  `{ "riotId": "NewFriend#EUW", "start": { "tier": "GOLD", "division": "IV", "lp": 0 } },`
- **Remove:** delete their line. Make sure the last line has no comma at the end.

The change shows on the site after the next update (within 10 minutes). If the update fails after an edit, the JSON is usually missing or has an extra comma.

## Keeping it running

- **Development keys expire every 24 hours.** Until Riot approves your Personal API Key, replace the `RIOT_API_KEY` secret with a fresh key each day. Once the personal key arrives, set it once and you're done.
- **Manual refresh:** Actions tab → Update standings → Run workflow.
- **Something wrong?** Open the latest run in the Actions tab. A `401`/`403` error means the key is missing or expired; "Riot ID not found" means a typo in `players.json`.
- GitHub can delay scheduled runs by a few minutes when it's busy, and pauses schedules after 60 days without repository activity (the bot's own commits count as activity).

## How the score works

Each division is worth 100 LP and each tier 400 LP. Master, Grandmaster and Challenger share one scale: Master 0 LP counts the same as one division above Diamond I. Remakes (games under 5 minutes) don't count toward games played.
