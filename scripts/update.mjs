// Fetches every player's Solo/Duo rank and race matches from the Riot API
// and writes data.json for the website. Runs in GitHub Actions.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
await mkdir("matches", { recursive: true });
const exists = f => access(f).then(() => true, () => false);

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

// Compact full scoreboard for the match-details view
function scoreboard(m) {
  const i = m.info;
  return {
    id: m.metadata.matchId, at: i.gameEndTimestamp || i.gameStartTimestamp, dur: i.gameDuration, queue: i.queueId, patch: (i.gameVersion || "").split(".").slice(0, 2).join("."),
    teams: i.teams.map(t => ({ id: t.teamId, win: t.win, kills: t.objectives?.champion?.kills ?? 0,
      obj: { baron: t.objectives?.baron?.kills ?? 0, dragon: t.objectives?.dragon?.kills ?? 0, herald: t.objectives?.riftHerald?.kills ?? 0,
             grubs: t.objectives?.horde?.kills ?? 0, tower: t.objectives?.tower?.kills ?? 0, inhib: t.objectives?.inhibitor?.kills ?? 0 } })),
    players: i.participants.map(x => ({
      name: x.riotIdGameName ? `${x.riotIdGameName}#${x.riotIdTagline}` : (x.summonerName || "?"), tracked: tracked[x.puuid] || null,
      team: x.teamId, champ: x.championName, lvl: x.champLevel, role: x.teamPosition || "",
      k: x.kills, d: x.deaths, a: x.assists, cs: x.totalMinionsKilled + x.neutralMinionsKilled, dmg: x.totalDamageDealtToChampions,
      taken: x.totalDamageTaken, gold: x.goldEarned, vis: x.visionScore, wards: x.wardsPlaced, multi: x.largestMultiKill,
      items: [x.item0, x.item1, x.item2, x.item3, x.item4, x.item5, x.item6], spells: [x.summoner1Id, x.summoner2Id],
      rune: x.perks?.styles?.[0]?.selections?.[0]?.perk ?? null, sub: x.perks?.styles?.[1]?.style ?? null })),
  };
}

const rankOf = r => ({ tier: r.tier, division: r.division, lp: r.lp });

const tracked = {}; // puuid -> riotId, for head-to-head
for (const p of cfg.players) { const prev = old.players?.[p.riotId]; if (prev?.puuid) tracked[prev.puuid] = p.riotId; }
const alerts = [];
const DIVS = { IV: 0, III: 1, II: 2, I: 3 }, TIERS = ["IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","GRANDMASTER","CHALLENGER"];
const step = r => r ? TIERS.indexOf(r.tier) * 4 + (TIERS.indexOf(r.tier) >= 7 ? 0 : DIVS[r.division]) : null;
const rankName = r => TIERS.indexOf(r.tier) >= 7 ? r.tier[0] + r.tier.slice(1).toLowerCase() : `${r.tier[0] + r.tier.slice(1).toLowerCase()} ${r.division}`;

const out = { updatedAt: new Date().toISOString(), raceStart: cfg.raceStart, players: {} };

for (const p of cfg.players) {
  const [name, tag] = p.riotId.split("#");
  const prev = old.players?.[p.riotId] || {};
  try {
    const puuid = prev.puuid || (await riot(cfg.region,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`))?.puuid;
    if (!puuid) throw new Error("Riot ID not found");
    tracked[puuid] = p.riotId;

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
        if (matches[id]?.v === 4 && await exists(`matches/${id}.json`)) continue; // already stored with full detail
        const m = await riot(cfg.region, `/lol/match/v5/matches/${id}`);
        const me = m?.info?.participants?.find(x => x.puuid === puuid);
        if (!me || m.info.gameDuration < 300) continue; // skip remakes
        if (!(await exists(`matches/${id}.json`))) await writeFile(`matches/${id}.json`, JSON.stringify(scoreboard(m)));
        const teamKills = m.info.participants.filter(x => x.teamId === me.teamId).reduce((s, x) => s + x.kills, 0);
        matches[id] = {
          win: me.win, champ: me.championName, role: me.teamPosition || "",
          k: me.kills, d: me.deaths, a: me.assists,
          cs: me.totalMinionsKilled + me.neutralMinionsKilled,
          dmg: me.totalDamageDealtToChampions, vis: me.visionScore, gold: me.goldEarned,
          kp: teamKills ? Math.round((me.kills + me.assists) / teamKills * 100) : 0,
          mates: m.info.participants.filter(x => x.puuid !== puuid && tracked[x.puuid])
            .map(x => ({ id: tracked[x.puuid], same: x.teamId === me.teamId })),
          multi: me.largestMultiKill || 0, penta: me.pentaKills || 0, fb: !!me.firstBloodKill,
          solo: me.challenges?.soloKills ?? 0, taken: me.totalDamageTaken, v: 4,
          dur: m.info.gameDuration, at: m.info.gameEndTimestamp || m.info.gameStartTimestamp,
        };
      }
      if (ids.length < 100) break;
    }

    // LP history for the graph: Riot only gives current LP, so record a point whenever it changes.
    const start = p.start || prev.start || current; // baseline: given, else first seen
    // Baseline time: race start if a starting rank was given, otherwise the moment the player was added.
    const history = prev.history?.length ? [...prev.history] : (start ? [{ t: p.start ? Date.parse(cfg.raceStart) : Date.now(), ...rankOf(start) }] : []);
    if (current) {
      const last = history[history.length - 1];
      if (!last || last.tier !== current.tier || last.division !== current.division || last.lp !== current.lp)
        history.push({ t: Date.now(), ...rankOf(current) });
    }

    if (prev.current && current && step(prev.current) !== step(current)) {
      const up = step(current) > step(prev.current);
      alerts.push(`${up ? "🔼" : "🔽"} **${p.riotId.split("#")[0]}** ${up ? "promoted to" : "demoted to"} **${rankName(current)}** (${current.lp} LP)`);
    }

    // Profile icon and level (cosmetic; ignore failures)
    let icon = prev.icon ?? null, level = prev.level ?? null;
    try { const sm = await riot(cfg.platform, `/lol/summoner/v4/summoners/by-puuid/${puuid}`); if (sm) { icon = sm.profileIconId; level = sm.summonerLevel; } }
    catch (e) { console.error(`summoner lookup failed for ${p.riotId}: ${e.message}`); }

    // Live game (404 = not in game)
    let live = null, liveErr = null;
    try {
      const g = await riot(cfg.platform, `/lol/spectator/v5/active-games/by-summoner/${puuid}`);
      const me = g?.participants?.find(x => x.puuid === puuid);
      if (g && me) live = { champId: me.championId, queue: g.gameQueueConfigId, start: g.gameStartTime || Date.now(),
        mates: g.participants.filter(x => x.puuid !== puuid && tracked[x.puuid]).map(x => ({ id: tracked[x.puuid], same: x.teamId === me.teamId })) };
    } catch (e) { liveErr = e.message; console.error(`live check failed for ${p.riotId}: ${e.message}`); }

    // Ghost games: Riot's live service sometimes keeps reporting a finished game.
    if (live) {
      const done = ms => Object.values(ms || {}).some(m => m.at - (m.dur || 0) * 1000 >= live.start - 3 * 60e3);
      const over = done(matches) || (live.mates || []).some(x => done((out.players[x.id] || old.players?.[x.id])?.matches));
      if (over || Date.now() - live.start > 70 * 60e3) live = null;
    }

    out.players[p.riotId] = { riotId: p.riotId, puuid, start, current, history, matches, live, liveErr, icon, level, checkedAt: Date.now() };
    console.log(`OK ${p.riotId}: ${current ? `${current.tier} ${current.division} ${current.lp}LP` : "unranked"}, ${Object.keys(matches).length} games`);
  } catch (e) {
    console.error(`FAIL ${p.riotId}: ${e.message}`);
    out.players[p.riotId] = { ...prev, riotId: p.riotId, error: e.message };
  }
}

if (alerts.length && process.env.DISCORD_WEBHOOK) {
  const site = process.env.SITE_URL ? `\n<${process.env.SITE_URL}>` : "";
  const res = await fetch(process.env.DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Climb Race", content: alerts.join("\n") + site }) });
  console.log(`Discord: ${alerts.length} alert(s), status ${res.status}`);
}

await writeFile("data.json", JSON.stringify(out, null, 1));
