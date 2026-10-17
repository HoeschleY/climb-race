// Climb Race lookup proxy (Cloudflare Worker).
// Lets the website look up any player live without exposing the Riot API key: the key is stored
// as a secret in Cloudflare (RIOT_API_KEY) and never leaves this worker.
//   GET /player?id=Name%23TAG   rank + last 10 ranked Solo/Duo games
//   GET /match?id=EUW1_123      full scoreboard of one game (same shape as the site's saved games)
// Answers are cached (players 10 min, games 7 days), so repeated clicks cost no Riot requests.
const PLATFORM = "euw1", REGION = "europe";
const ALLOWED = ["https://hoeschley.github.io"];
const GAMES = 10;

/*RATING*/

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ALLOWED.includes(o) ? o : ALLOWED[0], "Vary": "Origin" };
}
const json = (req, body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store", ...cors(req) } });

class RiotError extends Error { constructor(status, retry) { super("riot " + status); this.status = status; this.retry = retry; } }
async function riot(env, host, path) {
  const r = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
  if (r.status === 404) return null;
  if (!r.ok) throw new RiotError(r.status, +r.headers.get("retry-after") || 0);
  return r.json();
}
const nameOf = x => x.riotIdGameName ? `${x.riotIdGameName}#${x.riotIdTagline}` : (x.summonerName || "?");

function scoreboard(m) {
  const i = m.info;
  const sb = {
    id: m.metadata.matchId, at: i.gameEndTimestamp || i.gameStartTimestamp, dur: i.gameDuration, queue: i.queueId,
    patch: (i.gameVersion || "").split(".").slice(0, 2).join("."), live: true,
    teams: i.teams.map(t => ({ id: t.teamId, win: t.win, kills: t.objectives?.champion?.kills ?? 0,
      obj: { baron: t.objectives?.baron?.kills ?? 0, dragon: t.objectives?.dragon?.kills ?? 0, herald: t.objectives?.riftHerald?.kills ?? 0,
        grubs: t.objectives?.horde?.kills ?? 0, tower: t.objectives?.tower?.kills ?? 0, inhib: t.objectives?.inhibitor?.kills ?? 0 } })),
    players: i.participants.map(x => ({
      name: nameOf(x), tracked: null, team: x.teamId, champ: x.championName, lvl: x.champLevel, role: x.teamPosition || "",
      k: x.kills, d: x.deaths, a: x.assists, cs: x.totalMinionsKilled + x.neutralMinionsKilled, dmg: x.totalDamageDealtToChampions,
      taken: x.totalDamageTaken, gold: x.goldEarned, vis: x.visionScore, wards: x.wardsPlaced, multi: x.largestMultiKill,
      items: [x.item0, x.item1, x.item2, x.item3, x.item4, x.item5, x.item6], spells: [x.summoner1Id, x.summoner2Id],
      rune: x.perks?.styles?.[0]?.selections?.[0]?.perk ?? null, sub: x.perks?.styles?.[1]?.style ?? null })),
  };
  try { const r = rateGame(sb); sb.players.forEach((x, k) => { x.rating = r[k].rating; x.place = r[k].place; }); } catch {}
  return sb;
}

// One game, cached for a week (finished games never change)
async function getMatch(env, ctx, id) {
  const key = new Request(`https://cache.climb-race/match/${id}`), cache = caches.default;
  const hit = await cache.match(key); if (hit) return hit.json();
  const m = await riot(env, REGION, `/lol/match/v5/matches/${id}`); if (!m) return null;
  const sb = scoreboard(m);
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(sb), { headers: { "Cache-Control": "public, max-age=604800" } })));
  return sb;
}

async function player(env, ctx, id) {
  const [name, tag] = id.split("#"); if (!name || !tag) return { error: "Use Name#TAG" };
  const acc = await riot(env, REGION, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
  if (!acc) return { error: "Player not found" };
  const [entries, sum, ids] = await Promise.all([
    riot(env, PLATFORM, `/lol/league/v4/entries/by-puuid/${acc.puuid}`),
    riot(env, PLATFORM, `/lol/summoner/v4/summoners/by-puuid/${acc.puuid}`),
    riot(env, REGION, `/lol/match/v5/matches/by-puuid/${acc.puuid}/ids?queue=420&count=${GAMES}`)]);
  const e = (entries || []).find(z => z.queueType === "RANKED_SOLO_5x5");
  const matches = (await Promise.all((ids || []).map(mid => getMatch(env, ctx, mid).catch(() => null)))).filter(Boolean);
  const riotId = `${acc.gameName}#${acc.tagLine}`;
  const games = matches.map(sb => {
    const me = sb.players.find(x => x.name.toLowerCase() === riotId.toLowerCase()); if (!me) return null;
    const team = sb.teams.find(t => t.id === me.team), tk = sb.players.filter(x => x.team === me.team).reduce((s, x) => s + x.k, 0) || 1;
    return { id: sb.id, at: sb.at, dur: sb.dur, win: !!team?.win, champ: me.champ, role: me.role, k: me.k, d: me.d, a: me.a, cs: me.cs,
      dmg: me.dmg, gold: me.gold, vis: me.vis, kp: Math.round((me.k + me.a) / tk * 100), rating: me.rating ?? null, place: me.place ?? null,
      items: me.items, spells: me.spells, rune: me.rune, sub: me.sub,
      vs: sb.players.filter(x => x.team !== me.team).map(x => x.champ), with: sb.players.filter(x => x.team === me.team && x !== me).map(x => x.champ) };
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  return { riotId, level: sum?.summonerLevel ?? null, icon: sum?.profileIconId ?? null, at: Date.now(),
    rank: e ? { tier: e.tier, division: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses, hot: !!e.hotStreak } : null, games };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors(req), "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    const url = new URL(req.url), id = (url.searchParams.get("id") || "").trim().slice(0, 60);
    if (!env.RIOT_API_KEY) return json(req, { error: "RIOT_API_KEY secret is missing in the worker settings" }, 500);
    try {
      if (url.pathname === "/player") {
        const key = new Request(`https://cache.climb-race/player/${encodeURIComponent(id.toLowerCase())}`), cache = caches.default;
        const hit = await cache.match(key); if (hit) return json(req, await hit.json(), 200, 120);
        const out = await player(env, ctx, id);
        if (out.error) return json(req, out, 404);
        ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "public, max-age=600" } })));
        return json(req, out, 200, 120);
      }
      if (url.pathname === "/match") {
        if (!/^[A-Z0-9]+_\d+$/.test(id)) return json(req, { error: "Bad match id" }, 400);
        const sb = await getMatch(env, ctx, id); return sb ? json(req, sb, 200, 86400) : json(req, { error: "Game not found" }, 404);
      }
      if (url.pathname === "/") return json(req, { ok: true, service: "climb-race lookup" });
      return json(req, { error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof RiotError) {
        if (e.status === 429) return json(req, { error: "Riot's rate limit is reached, try again in a minute", retry: e.retry || 60 }, 429);
        if (e.status === 401 || e.status === 403) return json(req, { error: "Riot refused the API key (expired?). Update RIOT_API_KEY in the worker settings." }, 502);
        return json(req, { error: `Riot error ${e.status}` }, 502);
      }
      return json(req, { error: "Lookup failed" }, 500);
    }
  },
};
