/**
 * Pair Discovery Service
 *
 * Recurring bot module that runs the correlated-pair suggestion logic on a
 * configurable interval.  The underlying algorithm is identical to the one-off
 * script at scripts/suggest-correlated-pairs.ts — this class wraps it so it can
 * be scheduled as a long-running module inside bot/index.ts.
 *
 * ── Safety invariant ─────────────────────────────────────────────────────────
 *
 * THIS SERVICE NEVER WRITES TO `correlated_market_pairs` DIRECTLY.
 * It only inserts rows into `correlated_pair_suggestions` with status='pending'.
 * Human approval remains 100% manual:
 *   review:  npx tsx scripts/review-pair-suggestions.ts
 *   approve: npx tsx scripts/approve-pair-suggestion.ts <id>
 *
 * ── Events emitted ───────────────────────────────────────────────────────────
 *   'started'      — service initialised and first run queued
 *   'run-started'  — a discovery pass began
 *   'run-complete' — a pass finished ({ inserted, discarded, total, nextRunMs })
 *   'stopped'      — service stopped cleanly
 *   'error'        — Error object; caller (runWithRestart) should decide restart
 *
 * ── Scheduling ───────────────────────────────────────────────────────────────
 * The NEXT run is always scheduled AFTER the current one completes, so long
 * passes (up to ~12 min for 500 candidates × 1.5 s/call) never overlap.
 *
 * ── Configuration ────────────────────────────────────────────────────────────
 *   intervalMs              — milliseconds between successive runs (required)
 *   confidenceThreshold     — min Claude confidence score to store (default 0.6)
 *   pageSize                — Gamma API markets per page (default 500, max 500)
 *   maxPages                — max pages to fetch per run (default 5 → 2 500 markets)
 *   maxCandidates           — global cap on Claude API calls per run (default 500)
 *   maxCandidatesPerEvent   — per-event diversity cap (default 15)
 *   claudeCallDelayMs       — delay between consecutive Anthropic calls (default 1 500)
 *   claudeModel             — model ID for pair classification (default claude-haiku-4-5)
 */

import { EventEmitter } from 'events';
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GammaApiClient, GammaMarket } from '../clients/gamma-api.js';
import type { Database } from '../../modules/shared/database.types.js';
import { createLogger } from '../../modules/shared/logger.js';

const log = createLogger('pair-discovery');

// ── Constants — mirrors suggest-correlated-pairs.ts ──────────────────────────

const DEFAULT_CONFIDENCE_THRESHOLD    = 0.6;
const DEFAULT_PAGE_SIZE               = 500;
const DEFAULT_MAX_PAGES               = 5;
const DEFAULT_MAX_CANDIDATES          = 500;
const DEFAULT_MAX_CANDIDATES_PER_EVENT = 15;
const DEFAULT_CLAUDE_CALL_DELAY_MS    = 1_500;
const DEFAULT_CLAUDE_MODEL            = 'claude-haiku-4-5-20251001';

// ── Proper-noun heuristic — copied verbatim from suggest-correlated-pairs.ts ─

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
 * Extract capitalised tokens from a market question that are likely proper nouns.
 * Cheap heuristic — false positives are acceptable; Claude is the authoritative
 * classifier.  The heuristic only prunes the O(N²) candidate space.
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

// ── Claude classification — copied verbatim from suggest-correlated-pairs.ts ─

interface ClassificationResult {
  relationship: 'a_implies_b' | 'mutually_exclusive' | 'none';
  confidence:   number;
  reasoning:    string;
}

async function classifyPair(
  anthropic:  Anthropic,
  questionA:  string,
  questionB:  string,
  model:      string,
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
    model,
    max_tokens: 256,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw     = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed: ClassificationResult;
  try {
    parsed = JSON.parse(cleaned) as ClassificationResult;
  } catch {
    log.warn('Claude returned non-JSON; treating as none', { raw });
    return { relationship: 'none', confidence: 0, reasoning: 'parse error' };
  }

  if (!['a_implies_b', 'mutually_exclusive', 'none'].includes(parsed.relationship)) {
    parsed.relationship = 'none';
  }
  parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  parsed.reasoning  = String(parsed.reasoning || '').slice(0, 500);

  return parsed;
}

// ── Config type ───────────────────────────────────────────────────────────────

export interface PairDiscoveryConfig {
  /** Milliseconds between successive discovery runs.  Required. */
  intervalMs:             number;
  /** Min Claude confidence score (0–1) to store a suggestion. @default 0.6 */
  confidenceThreshold?:   number;
  /** Markets per Gamma API page (max 500). @default 500 */
  pageSize?:              number;
  /** Maximum pages to fetch per run. @default 5 */
  maxPages?:              number;
  /** Global cap on Claude API calls per run. @default 500 */
  maxCandidates?:         number;
  /** Per-event diversity cap (prevents one event consuming whole budget). @default 15 */
  maxCandidatesPerEvent?: number;
  /** Delay (ms) between Anthropic calls to stay within rate limits. @default 1500 */
  claudeCallDelayMs?:     number;
  /** Anthropic model to use for classification. @default claude-haiku-4-5-20251001 */
  claudeModel?:           string;
}

// ── Run stats (emitted with 'run-complete') ───────────────────────────────────

export interface PairDiscoveryRunStats {
  /** Pairs classified by Claude in this run. */
  total:        number;
  /** Suggestions stored in correlated_pair_suggestions (status='pending'). */
  inserted:     number;
  /** Pairs discarded (relationship='none' or confidence below threshold). */
  discarded:    number;
  /** Milliseconds until the next scheduled run. */
  nextRunMs:    number;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PairDiscoveryService extends EventEmitter {
  private stopped  = false;
  private timer:   ReturnType<typeof setTimeout> | null = null;

  private readonly intervalMs:            number;
  private readonly confidenceThreshold:   number;
  private readonly pageSize:              number;
  private readonly maxPages:              number;
  private readonly maxCandidates:         number;
  private readonly maxCandidatesPerEvent: number;
  private readonly claudeCallDelayMs:     number;
  private readonly claudeModel:           string;
  private readonly anthropic:             Anthropic;

  constructor(
    private readonly gammaApi:  GammaApiClient,
    private readonly supabase:  SupabaseClient<Database>,
    anthropicApiKey:             string,
    config:                      PairDiscoveryConfig,
  ) {
    super();
    this.intervalMs            = config.intervalMs;
    this.confidenceThreshold   = config.confidenceThreshold   ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.pageSize              = config.pageSize              ?? DEFAULT_PAGE_SIZE;
    this.maxPages              = config.maxPages              ?? DEFAULT_MAX_PAGES;
    this.maxCandidates         = config.maxCandidates         ?? DEFAULT_MAX_CANDIDATES;
    this.maxCandidatesPerEvent = config.maxCandidatesPerEvent ?? DEFAULT_MAX_CANDIDATES_PER_EVENT;
    this.claudeCallDelayMs     = config.claudeCallDelayMs     ?? DEFAULT_CLAUDE_CALL_DELAY_MS;
    this.claudeModel           = config.claudeModel           ?? DEFAULT_CLAUDE_MODEL;
    this.anthropic             = new Anthropic({ apiKey: anthropicApiKey });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;
    log.info('PairDiscovery service started', {
      intervalHours:        (this.intervalMs / 3_600_000).toFixed(2),
      confidenceThreshold:  this.confidenceThreshold,
      model:                this.claudeModel,
      maxMarketsToScan:     this.pageSize * this.maxPages,
      maxCandidatesPerEvent: this.maxCandidatesPerEvent,
      maxCandidatesTotal:   this.maxCandidates,
    });
    this.emit('started');

    // Run once immediately, then schedule subsequent runs.
    try {
      await this.runOnce();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }

    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info('PairDiscovery service stopped');
    this.emit('stopped');
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────

  /**
   * Schedules the next run after intervalMs.  The timer is always set AFTER a
   * run completes, so long passes never overlap.
   */
  private scheduleNext(): void {
    if (this.stopped) return;
    const hours = (this.intervalMs / 3_600_000).toFixed(2);
    log.info(`PairDiscovery: next run in ${hours}h`);
    this.timer = setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
      this.scheduleNext();
    }, this.intervalMs);
  }

  // ── Core discovery pass ─────────────────────────────────────────────────────

  /**
   * One full discovery pass — identical logic to suggest-correlated-pairs.ts main().
   *
   * NEVER touches correlated_market_pairs.
   * Writes ONLY to correlated_pair_suggestions with status='pending'.
   */
  private async runOnce(): Promise<void> {
    this.emit('run-started');
    log.info('PairDiscovery run starting', {
      confidenceThreshold:   this.confidenceThreshold,
      model:                 this.claudeModel,
      maxMarketsToScan:      this.pageSize * this.maxPages,
      maxCandidatesPerEvent: this.maxCandidatesPerEvent,
      maxCandidatesTotal:    this.maxCandidates,
    });

    // ── 1. Fetch all active markets (paginated) ────────────────────────────

    log.info('Fetching active markets from Gamma API…');
    const allMarkets: GammaMarket[] = [];

    for (let page = 0; page < this.maxPages; page++) {
      const batch = await this.gammaApi.getMarkets({
        active:    true,
        closed:    false,
        limit:     this.pageSize,
        offset:    page * this.pageSize,
        order:     'volume24hr',
        ascending: false,
      });
      allMarkets.push(...batch);
      log.info(`Page ${page + 1}: ${batch.length} markets (running total: ${allMarkets.length})`);
      if (batch.length < this.pageSize) break;  // reached last page
    }

    // Keep only markets with all required fields.
    const markets = allMarkets.filter(
      (m): m is GammaMarket & { conditionId: string; slug: string; question: string } =>
        Boolean(m.conditionId) && Boolean(m.slug) && Boolean(m.question),
    );
    log.info(`Markets after field filter: ${markets.length}`);

    // ── 2. Build event-group index (groupId → Set<conditionId>) ───────────

    const eventGroups = new Map<string, Set<string>>();
    for (const m of markets) {
      if (!m.groupId) continue;
      let group = eventGroups.get(m.groupId);
      if (!group) { group = new Set(); eventGroups.set(m.groupId, group); }
      group.add(m.conditionId);
    }

    const sameEvent = (condA: string, condB: string): boolean => {
      for (const group of eventGroups.values()) {
        if (group.has(condA) && group.has(condB)) return true;
      }
      return false;
    };

    // ── 3. Load existing suggestions (any status) to skip reprocessing ────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing, error: existingErr } = await (this.supabase as any)
      .from('correlated_pair_suggestions')
      .select('market_a_condition_id, market_b_condition_id');

    if (existingErr) throw new Error(`DB read failed: ${existingErr.message}`);

    // Store both orderings so we skip the pair regardless of A/B assignment.
    const existingPairs = new Set<string>(
      (existing as Array<{ market_a_condition_id: string; market_b_condition_id: string }> ?? [])
        .flatMap((r) => [
          `${r.market_a_condition_id}::${r.market_b_condition_id}`,
          `${r.market_b_condition_id}::${r.market_a_condition_id}`,
        ]),
    );
    log.info(`Existing suggestions in DB (any status): ${existingPairs.size / 2}`);

    // ── 4. Pre-filter candidate pairs via inverted proper-noun index ───────
    //
    // We build an inverted index: noun → list of market indices that contain it.
    // Only markets sharing ≥1 proper noun generate a candidate pair.
    // O(N × K) where K = avg proper nouns per market — far better than O(N²)
    // for 2500 markets.

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
    const pairKeySet = new Set<string>();   // "i:j" with i < j always
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

    // Sort by shared-term count descending — strongest heuristic matches first.
    allCandidates.sort((x, y) => y.shared.length - x.shared.length);

    // Per-event diversity cap: no single event group may contribute more than
    // maxCandidatesPerEvent pairs, preventing one high-volume fixture from
    // consuming the entire Claude API budget.
    const eventPairCounts = new Map<string, number>();
    const candidates: Candidate[] = [];

    for (const c of allCandidates) {
      const gA = c.a.groupId ?? `__solo_${c.a.conditionId}`;
      const gB = c.b.groupId ?? `__solo_${c.b.conditionId}`;
      const cntA = eventPairCounts.get(gA) ?? 0;
      const cntB = eventPairCounts.get(gB) ?? 0;
      if (cntA >= this.maxCandidatesPerEvent || cntB >= this.maxCandidatesPerEvent) continue;
      candidates.push(c);
      eventPairCounts.set(gA, cntA + 1);
      eventPairCounts.set(gB, cntB + 1);
    }

    log.info(`Candidates after per-event cap (max ${this.maxCandidatesPerEvent}/event): ${candidates.length}`);

    if (candidates.length === 0) {
      log.info('No new candidate pairs to classify.');
      const stats: PairDiscoveryRunStats = { total: 0, inserted: 0, discarded: 0, nextRunMs: this.intervalMs };
      this.emit('run-complete', stats);
      return;
    }

    // Global safety cap — applied after the per-event cap.
    if (candidates.length > this.maxCandidates) {
      log.warn(
        `Total candidates (${candidates.length}) exceeds maxCandidates (${this.maxCandidates}). ` +
        `Truncating. Re-run to process the rest (existing pairs are skipped automatically).`,
      );
      candidates.splice(this.maxCandidates);
    }

    // ── 5. Classify each pair via Claude; insert qualifying suggestions ────

    log.info(`Classifying ${candidates.length} pairs via Claude (${this.claudeModel})…`);
    let inserted = 0;
    let discarded = 0;

    for (let idx = 0; idx < candidates.length; idx++) {
      // Honour stop() during long classification runs.
      if (this.stopped) {
        log.info('PairDiscovery stopped mid-run — aborting classification loop', {
          processedSoFar: idx,
          remaining:      candidates.length - idx,
        });
        break;
      }

      const { a, b, shared } = candidates[idx]!;

      log.info(`Pair ${idx + 1}/${candidates.length}`, {
        sharedTerms: shared.join(', '),
        questionA:   a.question.slice(0, 80),
        questionB:   b.question.slice(0, 80),
      });

      const result = await classifyPair(this.anthropic, a.question, b.question, this.claudeModel);

      if (result.relationship === 'none' || result.confidence < this.confidenceThreshold) {
        log.info('Discarded', { relationship: result.relationship, confidence: result.confidence });
        discarded++;
      } else {
        // ── SAFETY CHECK: only correlated_pair_suggestions is written to ──
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (this.supabase as any)
          .from('correlated_pair_suggestions')   // ← NEVER correlated_market_pairs
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
              // status intentionally omitted — DB default is 'pending'
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

      if (idx < candidates.length - 1) await sleep(this.claudeCallDelayMs);
    }

    const stats: PairDiscoveryRunStats = {
      total:     candidates.length,
      inserted,
      discarded,
      nextRunMs: this.intervalMs,
    };

    log.info('PairDiscovery run complete', { ...stats });
    this.emit('run-complete', stats);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
