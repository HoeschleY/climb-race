// Fetches every player's Solo/Duo rank and race matches from the Riot API
// and writes data.json for the website. Runs in GitHub Actions.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { rateGame, RATING_VERSION } from "./rating.mjs";
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
// Every round has a hard time budget: once it's used up, no more Riot calls are made and the round
// saves what it has, so a slow or rate-limiting Riot can never stop the site from updating.
const ROUND_START = Date.now(), DEADLINE = ROUND_START + 110e3;
const diag = { calls: 0, status: {}, slow: 0, timeouts: 0, retryAfter: 0, budgetHit: false };
async function riot(host, path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Date.now() > DEADLINE) { diag.budgetHit = true; throw new Error("round time budget used up"); }
    await sleep(700);
    let res; const t = Date.now(); diag.calls++;
    try { res = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { "X-Riot-Token": KEY }, signal: AbortSignal.timeout(8000) }); }
    catch (e) { diag.timeouts++; if (attempt === 2) throw new Error(`no response on ${path}`); continue; }
    if (Date.now() - t > 3000) diag.slow++;
    diag.status[res.status] = (diag.status[res.status] || 0) + 1;
    if (res.status === 429) {
      const ra = +res.headers.get("retry-after") || 10; diag.retryAfter = Math.max(diag.retryAfter, ra);
      if (ra > 20 || Date.now() + ra * 1000 > DEADLINE) { diag.budgetHit = true; throw new Error(`rate limited for ${ra}s`); }
      await sleep(ra * 1000); continue;
    }
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

// Version of the website, so open tabs can switch to a newly deployed page
let build = null;
try { build = (await readFile("index.html", "utf8")).match(/const BUILD="(\d+)"/)?.[1] ?? null; } catch {}

const out = { updatedAt: new Date().toISOString(), build, raceStart: cfg.raceStart, players: {} };

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
    let iconAt = prev.iconAt ?? 0;
    if (Date.now() - iconAt > 15 * 60e3) try { const sm = await riot(cfg.platform, `/lol/summoner/v4/summoners/by-puuid/${puuid}`); if (sm) { icon = sm.profileIconId; level = sm.summonerLevel; iconAt = Date.now(); } }
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

    out.players[p.riotId] = { riotId: p.riotId, puuid, start, current, history, matches, live, liveErr, icon, level, iconAt };
    console.log(`OK ${p.riotId}: ${current ? `${current.tier} ${current.division} ${current.lp}LP` : "unranked"}, ${Object.keys(matches).length} games`);
  } catch (e) {
    console.error(`FAIL ${p.riotId}: ${e.message}`);
    out.players[p.riotId] = { ...prev, riotId: p.riotId, error: e.message };
  }
}

// Laning: per-minute timeline for each game (gold/CS at 15, team gold lead).
// Backfills at most 12 games per round to stay well within Riot's rate limit.
{
  const ids = [...new Set(Object.values(out.players).flatMap(pl => Object.keys(pl.matches || {})))];
  let fetched = 0;
  for (const id of ids) {
    const file = `matches/${id}.json`;
    let sb; try { sb = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
    if (!sb.tl || sb.tlv !== 2) {
      if (fetched >= 12) continue;
      fetched++;
      try {
        const t = await riot(cfg.region, `/lol/match/v5/matches/${id}/timeline`);
        const fr = t?.info?.frames || [];
        if (!fr.length) continue;
        const pf = (f, i) => f.participantFrames?.[i + 1] || {};
        const at = fr[Math.min(15, fr.length - 1)], blue = sb.players.map(x => x.team === 100);
        sb.tl = {
          min15: fr.length > 15,
          // Blue team gold minus red team gold, one value per minute
          goldDiff: fr.map(f => sb.players.reduce((s, _, i) => s + (blue[i] ? 1 : -1) * (pf(f, i).totalGold || 0), 0)),
        };
        sb.players.forEach((x, i) => { const p = pf(at, i); x.g15 = p.totalGold ?? null; x.cs15 = (p.minionsKilled || 0) + (p.jungleMinionsKilled || 0); x.xp15 = p.xp ?? null; });
        // Every champion kill with map position: [victim, killer, seconds, x, y] (indexes into players; killer -1 = tower/minion)
        sb.kills = fr.flatMap(f => (f.events || []).filter(e => e.type === "CHAMPION_KILL" && e.position)
          .map(e => [e.victimId - 1, (e.killerId || 0) - 1, Math.round(e.timestamp / 1000), e.position.x, e.position.y]));
        sb.tlv = 2;
        await writeFile(file, JSON.stringify(sb));
      } catch (e) { console.error(`timeline failed for ${id}: ${e.message}`); continue; }
    }
    // Average rating of teammates and enemies (ratings are added to the scoreboard by the rating step)
    if (sb.players.every(x => x.rating != null)) for (const x of sb.players) {
      const m = x.tracked && out.players[x.tracked]?.matches?.[id];
      if (!m || m.teamR !== undefined) continue;
      const avg = a => Math.round(a.reduce((s, y) => s + y.rating, 0) / a.length * 10) / 10;
      m.teamR = avg(sb.players.filter(y => y.team === x.team && y !== x));
      m.enemyR = avg(sb.players.filter(y => y.team !== x.team));
    }
    // Death and kill positions on each tracked player's game
    if (sb.kills) sb.players.forEach((x, i) => {
      const m = x.tracked && out.players[x.tracked]?.matches?.[id];
      if (!m || m.dpos !== undefined) return;
      m.side = x.team;
      m.dpos = sb.kills.filter(k => k[0] === i).map(k => [k[3], k[4], k[2]]);
      m.kpos = sb.kills.filter(k => k[1] === i).map(k => [k[3], k[4], k[2]]);
    });
    // Store lane diffs at 15 on each tracked player's game
    for (const x of sb.players) {
      const m = x.tracked && out.players[x.tracked]?.matches?.[id];
      if (!m || m.gd15 !== undefined) continue;
      const opp = sb.players.find(y => y.team !== x.team && y.role && y.role === x.role);
      Object.assign(m, sb.tl.min15 && opp && x.g15 != null
        ? { g15: x.g15, cs15: x.cs15, gd15: x.g15 - opp.g15, csd15: x.cs15 - opp.cs15, xpd15: (x.xp15 ?? 0) - (opp.xp15 ?? 0) }
        : { gd15: null });
    }
  }
  if (fetched) console.log(`timelines fetched: ${fetched}`);
}

// Allies/enemies per game, from the saved scoreboards (no API calls)
for (const pl of Object.values(out.players)) {
  for (const [id, m] of Object.entries(pl.matches || {})) {
    if (m.vs && m.rv === RATING_VERSION) continue;
    try {
      const file = `matches/${id}.json`, sb = JSON.parse(await readFile(file, "utf8"));
      const me = sb.players.find(x => x.tracked === pl.riotId) || sb.players.find(x => x.champ === m.champ && x.k === m.k && x.d === m.d);
      if (!me) continue;
      m.vs = sb.players.filter(x => x.team !== me.team).map(x => x.champ);
      m.with = sb.players.filter(x => x.team === me.team && x !== me).map(x => x.champ);
      // Lobby rating: saved on the game, and for all 10 players in the scoreboard file
      const r = rateGame(sb);
      if (sb.rv !== RATING_VERSION) {
        sb.players.forEach((x, i) => { x.rating = r[i].rating; x.place = r[i].place; });
        sb.rv = RATING_VERSION; await writeFile(file, JSON.stringify(sb));
      }
      const mine = r[sb.players.indexOf(me)];
      Object.assign(m, { rating: mine.rating, place: mine.place, good: mine.good, bad: mine.bad, laneGold: mine.laneGold, rv: RATING_VERSION });
      const avgR = a => Math.round(a.reduce((t, i) => t + r[i].rating, 0) / a.length * 10) / 10, idx = sb.players.map((_, i) => i);
      m.teamR = avgR(idx.filter(i => sb.players[i].team === me.team && sb.players[i] !== me));
      m.enemyR = avgR(idx.filter(i => sb.players[i].team !== me.team));
    } catch (e) { console.error(`rating failed for ${id}: ${e.message}`); }
  }
}

if (alerts.length && process.env.DISCORD_WEBHOOK) {
  const site = process.env.SITE_URL ? `\n<${process.env.SITE_URL}>` : "";
  const res = await fetch(process.env.DISCORD_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Climb Race", content: alerts.join("\n") + site }) });
  console.log(`Discord: ${alerts.length} alert(s), status ${res.status}`);
}

out.diag = { at: new Date().toISOString(), secs: Math.round((Date.now() - ROUND_START) / 1000), ...diag };
console.log("round health:", JSON.stringify(out.diag));
const strip = d => JSON.stringify({ ...d, updatedAt: 0, diag: 0, players: Object.fromEntries(Object.entries(d.players || {}).map(([k, v]) => [k, { ...v, iconAt: 0, checkedAt: 0 }])) });
const changed = strip(out) !== strip(old), heartbeat = !old.updatedAt || Date.now() - Date.parse(old.updatedAt) > 5 * 60e3;
const trouble = diag.budgetHit || diag.timeouts > 2 || Object.keys(diag.status).some(k => k !== "200" && k !== "404");
if (changed || heartbeat || trouble) await writeFile("data.json", JSON.stringify(out, null, 1));
console.log(changed ? "data changed" : heartbeat ? "heartbeat" : "no change");
