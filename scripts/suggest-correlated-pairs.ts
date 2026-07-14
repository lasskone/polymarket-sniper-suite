#!/usr/bin/env npx tsx
/**
 * Correlated Pair Suggester
 *
 * One-off script — run manually via `railway run tsx scripts/suggest-correlated-pairs.ts`
 * NOT wired into bot/index.ts. Never runs automatically.
 *
 * What it does:
 *   1. Fetches all active Polymarket markets via the existing Gamma API client.
 *   2. Groups markets by Polymarket event (groupId) and EXCLUDES same-event pairs —
 *      those are NegRisk's territory, not LogicArb's.
 *   3. Pre-filters candidate cross-event pairs using a proper-noun heuristic (shared
 *      capitalised terms in questions) to keep the Claude API bill sane.
 *   4. Skips pairs already in `correlated_pair_suggestions` (any status).
 *   5. Classifies each surviving pair via the Anthropic API (structured JSON output).
 *   6. Inserts qualifying suggestions (relationship != 'none', confidence >= threshold)
 *      into `correlated_pair_suggestions` with status='pending'.
 *
 * THIS SCRIPT NEVER WRITES TO `correlated_market_pairs` DIRECTLY.
 * Human approval is required: run `tsx scripts/approve-pair-suggestion.ts <id>`
 * after reviewing with `tsx scripts/review-pair-suggestions.ts`.
 *
 * Prerequisites (env vars):
 *   ANTHROPIC_API_KEY          — checked first; script exits immediately if missing.
 *   SUPABASE_URL               — Supabase project URL.
 *   SUPABASE_SERVICE_ROLE_KEY  — (or SUPABASE_ANON_KEY as fallback).
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { GammaApiClient }     from '../src/clients/gamma-api.js';
import type { GammaMarket }   from '../src/clients/gamma-api.js';
import { RateLimiter }        from '../src/core/rate-limiter.js';
import { Cache }              from '../src/core/cache.js';
import { LegacyCacheWrapper } from '../src/core/unified-cache.js';
import { getSupabaseClient }  from '../modules/shared/supabase-client.js';
import { createLogger }       from '../modules/shared/logger.js';

// ── Constants (tune before large runs) ───────────────────────────────────────

/**
 * Minimum Anthropic confidence score (0–1) for a pair to be stored.
 * Below this threshold the pair is silently discarded.
 * 0.6 balances recall vs. noise; raise to 0.75+ for fewer, higher-quality rows.
 */
const CONFIDENCE_THRESHOLD = 0.6;

/** Markets fetched per Gamma API page. Max accepted by the API is 500. */
const PAGE_SIZE = 500;

/**
 * Maximum pages of markets to scan (PAGE_SIZE × MAX_PAGES = max total markets).
 * 5 × 500 = 2 500 — covers all liquid Polymarket markets without exhausting
 * rate limits on a typical Railway run.
 */
const MAX_PAGES = 5;

/**
 * Safety cap on candidate pairs sent to the Claude API in a single run.
 * Each candidate = one API call; at CLAUDE_CALL_DELAY_MS = 1 500 ms, 500 calls ≈ 12 min.
 */
const MAX_CANDIDATES = 500;

/**
 * Maximum candidate pairs sourced from any single event group in one run.
 * Prevents one high-volume event (e.g. a major sports match with many prop
 * markets) from consuming the entire MAX_CANDIDATES budget and leaving no
 * room for other sports/events.
 * Applied before the global MAX_CANDIDATES cap.
 */
const MAX_CANDIDATES_PER_EVENT = 15;

/**
 * Delay (ms) between consecutive Anthropic API calls.
 * Claude Haiku tier-1 limit ≈ 50 req/min; 1 500 ms → ~40 req/min.
 */
const CLAUDE_CALL_DELAY_MS = 1_500;

/** Anthropic model for pair classification — Haiku is cheapest for this task. */
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const log = createLogger('suggest-correlated-pairs');

// ── Step 0: ANTHROPIC_API_KEY guard ──────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error(
    '\n❌  ANTHROPIC_API_KEY is not set.\n\n' +
    '    Railway:  Dashboard → your service → Variables → New Variable\n' +
    '              Key: ANTHROPIC_API_KEY   Value: sk-ant-…\n\n' +
    '    Local:    Add ANTHROPIC_API_KEY=sk-ant-… to .env and re-run.\n',
  );
  process.exit(1);
}

// ── Proper-noun heuristic ─────────────────────────────────────────────────────

/**
 * Common sentence-opening words that are capitalised but not proper nouns.
 * Excluded from the heuristic to avoid spurious pair candidates.
 */
const STOPWORDS = new Set([
  'Will', 'Does', 'Is', 'Are', 'Was', 'Were', 'The', 'A', 'An', 'If',
  'When', 'What', 'Who', 'Which', 'By', 'In', 'On', 'At', 'To', 'For',
  'Of', 'And', 'Or', 'But', 'Not', 'Be', 'Have', 'Has', 'Had', 'Do',
  'Did', 'Can', 'Could', 'Would', 'Should', 'May', 'Might', 'Must', 'Shall',
  'How', 'Before', 'After', 'Between', 'More', 'Than', 'Over', 'Under',
  'During', 'Until', 'Get', 'Win', 'Lose', 'Hit', 'Score', 'Make', 'Take',
  'Go', 'Come', 'Yes', 'No', 'Most', 'First', 'Last', 'Next', 'Total',
]);

/**
 * Extract capitalised tokens from a market question that are likely proper nouns
 * (names of teams, players, countries, organisations, tournaments, etc.).
 * This is a cheap heuristic — false positives are acceptable because the Claude
 * API call is the authoritative classifier; the heuristic's only job is to
 * prune the O(n²) candidate space down to a manageable size.
 */
function extractProperNouns(text: string): Set<string> {
  const nouns = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/[^a-zA-Z]/g, '');
    if (word.length >= 3 && /^[A-Z]/.test(word) && !STOPWORDS.has(word)) {
      nouns.add(word);
    }
  }
  return nouns;
}

// ── Claude classification ─────────────────────────────────────────────────────

interface ClassificationResult {
  relationship: 'a_implies_b' | 'mutually_exclusive' | 'none';
  confidence: number;
  reasoning: string;
}

async function classifyPair(
  anthropic: Anthropic,
  questionA: string,
  questionB: string,
): Promise<ClassificationResult> {
  const prompt = `You are classifying the logical relationship between two Polymarket prediction market questions.

Polymarket betting conventions — apply these precisely:
- Over/Under (O/U) markets: "YES" means the actual total is OVER the stated line.
  Example: "O/U 2.5 goals" resolves YES only if total goals ≥ 3.
- Spread markets: "YES" means the named team wins by MORE than the spread margin.
  Example: "France (-1.5)" resolves YES only if France wins by 2 or more goals.
- Exact-score markets: "YES" means that precise scoreline occurred.

Market A: "${questionA}"
Market B: "${questionB}"

Determine whether they have one of these relationships:
- "a_implies_b": If Market A resolves YES, Market B MUST also resolve YES (A is a sufficient condition for B).
  Example: "Exact Score 3-0" implies "O/U 0.5" (any scoring outcome puts total over 0.5).
  Example: "Exact Score 3-0" implies "O/U 2.5" (3 goals > 2.5).
  Counter-example: "Exact Score 1-1" does NOT imply "O/U 2.5" (2 goals is under 2.5).
- "mutually_exclusive": Both markets CANNOT both resolve YES simultaneously.
  Example: "Exact Score 1-1" and "Spread: France (-1.5)" are mutually exclusive (a draw means France cannot win by 1.5+).
  Example: "O/U 1.5 goals = YES (over)" and "Exact Score 0-0" are mutually exclusive (0 goals is under 1.5).
- "none": No meaningful logical relationship.

Respond with valid JSON only — no markdown, no explanation outside the JSON:
{
  "relationship": "a_implies_b" | "mutually_exclusive" | "none",
  "confidence": <number 0.0–1.0>,
  "reasoning": "<one concise sentence explaining the classification>"
}`;

  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
  // Strip potential markdown code fences Claude occasionally adds despite instructions.
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed: ClassificationResult;
  try {
    parsed = JSON.parse(cleaned) as ClassificationResult;
  } catch {
    log.warn('Claude returned non-JSON; treating as none', { raw });
    return { relationship: 'none', confidence: 0, reasoning: 'parse error' };
  }

  // Validate and sanitise fields before returning.
  if (!['a_implies_b', 'mutually_exclusive', 'none'].includes(parsed.relationship)) {
    parsed.relationship = 'none';
  }
  parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  parsed.reasoning  = String(parsed.reasoning || '').slice(0, 500);

  return parsed;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info('Correlated pair suggester starting', {
    confidenceThreshold:    CONFIDENCE_THRESHOLD,
    model:                  CLAUDE_MODEL,
    maxMarketsToScan:       PAGE_SIZE * MAX_PAGES,
    maxCandidatesPerEvent:  MAX_CANDIDATES_PER_EVENT,
    maxCandidatesTotal:     MAX_CANDIDATES,
  });

  const anthropic   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const rateLimiter = new RateLimiter();
  const cache       = new LegacyCacheWrapper(new Cache());
  const gammaClient = new GammaApiClient(rateLimiter, cache);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db          = getSupabaseClient() as any;

  // ── 1. Fetch all active markets (paginated) ─────────────────────────────

  log.info('Fetching active markets from Gamma API…');
  const allMarkets: GammaMarket[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await gammaClient.getMarkets({
      active:    true,
      closed:    false,
      limit:     PAGE_SIZE,
      offset:    page * PAGE_SIZE,
      order:     'volume24hr',
      ascending: false,
    });
    allMarkets.push(...batch);
    log.info(`Page ${page + 1}: ${batch.length} markets (running total: ${allMarkets.length})`);
    if (batch.length < PAGE_SIZE) break; // reached last page
  }

  // Keep only markets with all required fields.
  const markets = allMarkets.filter(
    (m): m is GammaMarket & { conditionId: string; slug: string; question: string } =>
      Boolean(m.conditionId) && Boolean(m.slug) && Boolean(m.question),
  );
  log.info(`Markets after field filter: ${markets.length}`);

  // ── 2. Build event-group index (groupId → Set<conditionId>) ────────────

  const eventGroups = new Map<string, Set<string>>();
  for (const m of markets) {
    if (!m.groupId) continue;
    let group = eventGroups.get(m.groupId);
    if (!group) { group = new Set(); eventGroups.set(m.groupId, group); }
    group.add(m.conditionId);
  }

  function sameEvent(condA: string, condB: string): boolean {
    for (const group of eventGroups.values()) {
      if (group.has(condA) && group.has(condB)) return true;
    }
    return false;
  }

  // ── 3. Load existing suggestions (any status) to skip reprocessing ──────

  const { data: existing, error: existingErr } = await db
    .from('correlated_pair_suggestions')
    .select('market_a_condition_id, market_b_condition_id');

  if (existingErr) throw new Error(`DB read failed: ${existingErr.message}`);

  // Store both orderings so we skip the pair regardless of which was A and which B.
  const existingPairs = new Set<string>(
    (existing as Array<{ market_a_condition_id: string; market_b_condition_id: string }> ?? [])
      .flatMap((r) => [
        `${r.market_a_condition_id}::${r.market_b_condition_id}`,
        `${r.market_b_condition_id}::${r.market_a_condition_id}`,
      ]),
  );
  log.info(`Existing suggestions in DB (any status): ${existingPairs.size / 2}`);

  // ── 4. Pre-filter candidate cross-event pairs via inverted noun index ───
  //
  // We build an inverted index: noun → list of market indices that contain it.
  // Only markets sharing ≥1 proper noun generate a candidate pair.
  // This is O(N × K) where K = avg proper nouns per market, far better than
  // the O(N²) naïve approach for 2500 markets.

  log.info('Building proper-noun index…');
  const marketNouns: Set<string>[] = markets.map((m) => extractProperNouns(m.question));

  const nounIndex = new Map<string, number[]>();
  for (let i = 0; i < markets.length; i++) {
    for (const noun of marketNouns[i]!) {
      let list = nounIndex.get(noun);
      if (!list) { list = []; nounIndex.set(noun, list); }
      list.push(i);
    }
  }

  // Collect unique pair indices from the noun index.
  const pairKeySet = new Set<string>(); // "i:j" with i < j always
  for (const [, indices] of nounIndex) {
    if (indices.length < 2) continue;
    for (let x = 0; x < indices.length; x++) {
      for (let y = x + 1; y < indices.length; y++) {
        const lo = Math.min(indices[x]!, indices[y]!);
        const hi = Math.max(indices[x]!, indices[y]!);
        pairKeySet.add(`${lo}:${hi}`);
      }
    }
  }

  // Apply same-event and existing-pair filters, collect all passing pairs.
  type Candidate = { a: GammaMarket; b: GammaMarket; shared: string[] };
  const allCandidates: Candidate[] = [];

  for (const key of pairKeySet) {
    const [si, sj] = key.split(':');
    const i = parseInt(si!, 10);
    const j = parseInt(sj!, 10);
    const a = markets[i]!;
    const b = markets[j]!;

    if (sameEvent(a.conditionId, b.conditionId)) continue;

    const pairId = `${a.conditionId}::${b.conditionId}`;
    if (existingPairs.has(pairId)) continue;

    const shared = [...marketNouns[i]!].filter((n) => marketNouns[j]!.has(n));
    allCandidates.push({ a, b, shared });
  }

  log.info(`Candidate pairs after same-event + duplicate filter: ${allCandidates.length}`);

  // Sort by shared-term count descending so the strongest heuristic matches are
  // prioritised when the per-event or global cap kicks in.
  allCandidates.sort((x, y) => y.shared.length - x.shared.length);

  // Per-event diversity cap: no single event group may contribute more than
  // MAX_CANDIDATES_PER_EVENT pairs to the final candidate list.
  // This prevents one high-volume event (e.g. a major match with 40+ prop
  // markets) from consuming the entire Claude API budget on a single fixture.
  const eventPairCounts = new Map<string, number>();
  const candidates: Candidate[] = [];

  for (const c of allCandidates) {
    // Fallback key for markets with no groupId (solo / ungrouped markets).
    const gA = c.a.groupId ?? `__solo_${c.a.conditionId}`;
    const gB = c.b.groupId ?? `__solo_${c.b.conditionId}`;
    const cntA = eventPairCounts.get(gA) ?? 0;
    const cntB = eventPairCounts.get(gB) ?? 0;

    if (cntA >= MAX_CANDIDATES_PER_EVENT || cntB >= MAX_CANDIDATES_PER_EVENT) continue;

    candidates.push(c);
    eventPairCounts.set(gA, cntA + 1);
    eventPairCounts.set(gB, cntB + 1);
  }

  log.info(`Candidates after per-event cap (max ${MAX_CANDIDATES_PER_EVENT}/event): ${candidates.length}`);

  if (candidates.length === 0) {
    log.info('No new candidate pairs to classify. Exiting.');
    return;
  }

  // Global safety cap — applied after the per-event cap.
  if (candidates.length > MAX_CANDIDATES) {
    log.warn(
      `Total candidates (${candidates.length}) exceeds MAX_CANDIDATES (${MAX_CANDIDATES}). ` +
      `Truncating. Re-run to process the rest (existing pairs are skipped automatically).`,
    );
    candidates.splice(MAX_CANDIDATES);
  }

  // ── 5. Classify each pair via Claude, insert qualifying suggestions ──────

  log.info(`Classifying ${candidates.length} pairs via Claude (${CLAUDE_MODEL})…`);
  let inserted = 0;
  let discarded = 0;

  for (let idx = 0; idx < candidates.length; idx++) {
    const { a, b, shared } = candidates[idx]!;

    log.info(`Pair ${idx + 1}/${candidates.length}`, {
      sharedTerms: shared.join(', '),
      questionA:   a.question.slice(0, 80),
      questionB:   b.question.slice(0, 80),
    });

    const result = await classifyPair(anthropic, a.question, b.question);

    if (result.relationship === 'none' || result.confidence < CONFIDENCE_THRESHOLD) {
      log.info('Discarded', { relationship: result.relationship, confidence: result.confidence });
      discarded++;
    } else {
      const { error } = await db
        .from('correlated_pair_suggestions')
        .upsert(
          {
            market_a_condition_id: a.conditionId,
            market_b_condition_id: b.conditionId,
            market_a_slug:         a.slug,
            market_b_slug:         b.slug,
            market_a_question:     a.question,
            market_b_question:     b.question,
            relationship:          result.relationship,
            confidence:            result.confidence,
            reasoning:             result.reasoning,
            // status omitted — DB default is 'pending'
          },
          { onConflict: 'market_a_condition_id,market_b_condition_id', ignoreDuplicates: true },
        );

      if (error) {
        log.warn('Upsert error', { error: error.message, slugA: a.slug, slugB: b.slug });
      } else {
        log.info('Suggestion inserted', {
          relationship: result.relationship,
          confidence:   result.confidence.toFixed(2),
          reasoning:    result.reasoning,
        });
        inserted++;
      }
    }

    if (idx < candidates.length - 1) await sleep(CLAUDE_CALL_DELAY_MS);
  }

  log.info('Done', {
    total:     candidates.length,
    inserted,
    discarded,
  });
  log.info('Review pending suggestions: tsx scripts/review-pair-suggestions.ts');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
