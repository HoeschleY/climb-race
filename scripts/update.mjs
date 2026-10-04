// Fetches every player's Solo/Duo rank and race matches from the Riot API
// and writes data.json for the website. Runs in GitHub Actions.
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.RIOT_API_KEY;
if (!KEY) { console.error("Missing RIOT_API_KEY secret"); process.exit(1); }

const cfg = JSON.parse(await readFile("players.json", "utf8"));
let old = { players: {} };
try { old = JSON.parse(await readFile("data.json", "utf8")); } catch {}

const startSec = Math.floor(new Date(cfg.raceStart).getTime() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Dev keys allow 100 requests / 2 min, so space calls out.
async function riot(host, path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(1300);
    const res = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { "X-Riot-Token": KEY } });
    if (res.status === 429) { await sleep((+res.headers.get("retry-after") || 10) * 1000); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} on ${path}`);
    return res.json();
  }
  throw new Error(`Rate limited on ${path}`);
}

const out = { updatedAt: new Date().toISOString(), raceStart: cfg.raceStart, players: {} };

for (const p of cfg.players) {
  const [name, tag] = p.riotId.split("#");
  const prev = old.players?.[p.riotId] || {};
  try {
    const puuid = prev.puuid || (await riot(cfg.region,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`))?.puuid;
    if (!puuid) throw new Error("Riot ID not found");

    const entries = await riot(cfg.platform, `/lol/league/v4/entries/by-puuid/${puuid}`) || [];
    const solo = entries.find(e => e.queueType === "RANKED_SOLO_5x5");
    const current = solo
      ? { tier: solo.tier, division: solo.rank, lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses }
      : null;

    // Race matches: Solo/Duo (queue 420) since raceStart. Only new ones are downloaded.
    const matches = { ...(prev.matches || {}) };
    for (let start = 0; ; start += 100) {
      const ids = await riot(cfg.region,
        `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&startTime=${startSec}&start=${start}&count=100`) || [];
      for (const id of ids) {
        if (matches[id]) continue;
        const m = await riot(cfg.region, `/lol/match/v5/matches/${id}`);
        const me = m?.info?.participants?.find(x => x.puuid === puuid);
        if (!me || m.info.gameDuration < 300) continue; // skip remakes
        matches[id] = { win: me.win, champ: me.championName, k: me.kills, d: me.deaths, a: me.assists,
                        at: m.info.gameEndTimestamp || m.info.gameStartTimestamp };
      }
      if (ids.length < 100) break;
    }

    out.players[p.riotId] = {
      riotId: p.riotId, puuid,
      start: p.start || prev.start || current, // baseline: given, else first seen
      current, matches,
    };
    console.log(`OK ${p.riotId}: ${current ? `${current.tier} ${current.division} ${current.lp}LP` : "unranked"}, ${Object.keys(matches).length} games`);
  } catch (e) {
    console.error(`FAIL ${p.riotId}: ${e.message}`);
    out.players[p.riotId] = { ...prev, riotId: p.riotId, error: e.message };
  }
}

await writeFile("data.json", JSON.stringify(out, null, 1));
