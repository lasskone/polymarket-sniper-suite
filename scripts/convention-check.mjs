/**
 * convention-check.mjs
 *
 * Verifies the OddsPapi outcomeId convention: 101=home, 102=draw, 103=away.
 *
 * Unlike the full service this script does NOT require unambiguous Gamma matches.
 * It emits Betfair home/away fair probabilities for every fixture that has
 * betfair-ex 1X2 odds (regardless of whether Polymarket matching is clean),
 * and separately shows raw Gamma candidates for each team.
 *
 * Run: railway run node scripts/convention-check.mjs
 */

const ODDSPAPI_BASE = 'https://api.oddspapi.io/v4';
const GAMMA_BASE    = 'https://gamma-api.polymarket.com';

const API_KEY = process.env.ODDSPAPI_KEY ?? process.env.ODDS_API_KEY;
if (!API_KEY) {
  console.error('ODDSPAPI_KEY not set');
  process.exit(1);
}

function url(path, params = {}) {
  const qs = new URLSearchParams({ ...params, apiKey: API_KEY });
  return `${ODDSPAPI_BASE}${path}?${qs}`;
}

function midFair(back, lay) {
  if (!back || back <= 1 || !lay || lay <= back) return null;
  return 2 / (back + lay);
}

function pct(v) {
  return v != null ? (v * 100).toFixed(1) + '%' : 'n/a';
}

// Minimal team name normalisation (mirrors normalizeTeamName in the service).
function norm(raw) {
  const SUFFIXES = [
    ' football club', ' futbol club', ' fútbol club',
    ' sporting club', ' sport club', ' sports club',
    ' united fc', ' city fc',
    ' athletic club', ' athletic',
    ' fc', ' cf', ' sc', ' ac', ' bc', ' bk', ' sk', ' fk', ' nk',
    ' afc', ' rfc', ' utd',
  ];
  const ALIASES = {
    'man utd': 'manchester united', 'man city': 'manchester city',
    'psg': 'paris saint-germain', 'bvb': 'borussia dortmund',
    'spurs': 'tottenham hotspur', 'west ham': 'west ham united',
    'wolves': 'wolverhampton wanderers', 'forest': 'nottingham forest',
    'villa': 'aston villa', 'celtic fc': 'celtic', 'rangers fc': 'rangers',
  };
  let s = raw.toLowerCase().trim().replace(/[^\w\s\-&']/g, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const sfx of SUFFIXES) {
      if (s.endsWith(sfx)) { s = s.slice(0, -sfx.length).trimEnd(); changed = true; break; }
    }
  }
  s = s.trim();
  return ALIASES[s] ?? s;
}

// Major tournament name patterns — prefer these for Polymarket coverage.
const MAJOR_RE = /world cup|champions league|europa league|premier league|la liga|bundesliga|serie a|ligue 1|nations league/i;

// Fetch soccer fixtures for the next 7 days, sorted: major leagues first.
async function fetchFixtures() {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 86_400_000);
  const from = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const to   = end.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const res = await fetch(url('/fixtures', { sportId: 10, from, to }));
  if (!res.ok) throw new Error(`/fixtures: ${res.status}`);
  const data = await res.json();
  const all = Array.isArray(data) ? data : (data.fixtures ?? []);
  // Sort: major tournaments first, then by start time.
  return all.sort((a, b) => {
    const aM = MAJOR_RE.test(a.tournamentName) ? 0 : 1;
    const bM = MAJOR_RE.test(b.tournamentName) ? 0 : 1;
    if (aM !== bM) return aM - bM;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });
}

// Fetch betfair-ex 1X2 odds for a single fixture.
async function fetchBetfairOdds(fixtureId) {
  const res = await fetch(url('/odds', { fixtureId, bookmakers: 'betfair-ex' }));
  if (!res.ok) throw new Error(`/odds: ${res.status}`);
  return res.json();
}

// Fetch active Gamma markets (no cache — one-shot script).
async function fetchGamma() {
  const res = await fetch(
    `${GAMMA_BASE}/markets?active=true&closed=false&limit=500&order=volume24hr&ascending=false`,
  );
  if (!res.ok) throw new Error(`Gamma: ${res.status}`);
  return res.json();
}

function parseArr(v, fallback) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch {} }
  return fallback;
}

// Very rough question blocklist (matches the service).
const BLOCKLIST = /exact\s+score|spread:|both\s+teams|end\s+in\s+a\s+draw|halftime|half.time|o\/u\s+[\d.]|over\/under|advance\s+from|penalty|first\s+goal|anytime\s+scorer/i;

function isWinMarket(question, outcomes) {
  if (BLOCKLIST.test(question)) return false;
  const isYesNo = outcomes.length === 2 &&
    outcomes.map(o => o.toLowerCase()).sort().join(',') === 'no,yes';
  if (isYesNo) {
    const lo = question.toLowerCase();
    return lo.includes('win') || lo.includes('beat') || lo.includes('to advance') || lo.includes('qualify');
  }
  return true;
}

// Find Gamma candidates that mention either team name.
function findCandidates(gamma, normHome, normAway, kickoff) {
  const WINDOW_BEFORE = 6  * 60 * 60 * 1000;
  const WINDOW_AFTER  = 30 * 60 * 60 * 1000;
  const ko = new Date(kickoff).getTime();

  return gamma
    .filter(m => {
      if (!m.active || m.closed) return false;
      const endDate = new Date(m.endDate ?? 0).getTime();
      if (endDate < ko - WINDOW_BEFORE || endDate > ko + WINDOW_AFTER) return false;
      const outcomes = parseArr(m.outcomes, ['Yes','No']);
      if (!isWinMarket(m.question, outcomes)) return false;
      const q = m.question.toLowerCase();
      return q.includes(normHome) || q.includes(normAway);
    })
    .map(m => {
      const outcomes = parseArr(m.outcomes, ['Yes','No']);
      const prices   = parseArr(m.outcomePrices, [0.5, 0.5]).map(Number);
      const yesIdx   = outcomes.findIndex(o => o.toLowerCase() === 'yes');
      const price    = yesIdx >= 0 ? prices[yesIdx] : prices[0];
      return { question: m.question, conditionId: m.conditionId, price, outcomes };
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Fetching soccer fixtures and Gamma markets…\n');

const [fixtures, gamma] = await Promise.all([fetchFixtures(), fetchGamma()]);

console.log(`  ${fixtures.length} fixtures  |  ${gamma.length} Gamma markets\n`);
console.log('─'.repeat(90));

let checked = 0;

for (const fix of fixtures) {
  if (!fix.hasOdds) continue;
  if (checked >= 8) break;

  let odds;
  try { odds = await fetchBetfairOdds(fix.fixtureId); }
  catch (e) { console.error(`  ${fix.fixtureId}: odds fetch failed —`, e.message); continue; }

  const market1x2 = odds?.bookmakerOdds?.['betfair-ex']?.markets?.['101'];
  if (!market1x2) continue;

  const homeOv = market1x2.outcomes?.['101']?.players?.['0'];
  const awayOv = market1x2.outcomes?.['103']?.players?.['0'];

  const homeBack = homeOv?.price;
  const homeLay  = homeOv?.exchangeMeta?.availableToLay?.[0]?.price;
  const awayBack = awayOv?.price;
  const awayLay  = awayOv?.exchangeMeta?.availableToLay?.[0]?.price;

  const homeFair = midFair(homeBack, homeLay);
  const awayFair = midFair(awayBack, awayLay);

  const betfairFav = homeFair != null && awayFair != null
    ? (homeFair >= awayFair ? fix.participant1Name : fix.participant2Name)
    : 'unknown';

  const normHome = norm(fix.participant1Name);
  const normAway = norm(fix.participant2Name);

  const candidates = findCandidates(gamma, normHome, normAway, fix.startTime);

  // Find best home/away Gamma candidate (simple heuristic: first candidate
  // whose question mentions the team).
  const homeCand = candidates.find(c => c.question.toLowerCase().includes(normHome));
  const awayCand = candidates.find(c => c.question.toLowerCase().includes(normAway));

  const polyHomePct = homeCand ? pct(homeCand.price) : 'n/a';
  const polyAwayPct = awayCand ? pct(awayCand.price) : 'n/a';

  const polyFav = homeCand && awayCand
    ? (homeCand.price >= awayCand.price ? fix.participant1Name : fix.participant2Name)
    : 'unknown';

  const agree = betfairFav !== 'unknown' && polyFav !== 'unknown' && betfairFav === polyFav;
  const agreeMark = betfairFav === 'unknown' || polyFav === 'unknown'
    ? '— (insufficient data)'
    : agree ? '✓ AGREE' : '⚠ DISAGREE — check 101/103 mapping';

  checked++;
  console.log(`\n[${checked}] ${fix.participant1Name} (home) vs ${fix.participant2Name} (away)`);
  console.log(`    kickoff: ${fix.startTime}  |  ${fix.tournamentName}`);
  console.log(`    Betfair outcomeId 101 (HOME): back=${homeBack ?? 'n/a'} lay=${homeLay ?? 'n/a'} → fair=${pct(homeFair)}`);
  console.log(`    Betfair outcomeId 103 (AWAY): back=${awayBack ?? 'n/a'} lay=${awayLay ?? 'n/a'} → fair=${pct(awayFair)}`);
  console.log(`    Betfair implied favourite: ${betfairFav}`);
  if (homeCand) console.log(`    Poly home candidate : "${homeCand.question}" → ${polyHomePct}`);
  if (awayCand) console.log(`    Poly away candidate : "${awayCand.question}" → ${polyAwayPct}`);
  console.log(`    Polymarket implied favourite: ${polyFav}`);
  console.log(`    Convention check: ${agreeMark}`);
  if (candidates.length > 2) {
    console.log(`    (${candidates.length} total Gamma candidates — showing first per side)`);
  }
}

if (checked === 0) {
  console.log('\nNo fixtures with betfair-ex 1X2 odds found. Try again when live soccer fixtures are available.');
} else {
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`Checked ${checked} fixture(s).`);
}
