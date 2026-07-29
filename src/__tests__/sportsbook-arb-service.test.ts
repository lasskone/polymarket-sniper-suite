/**
 * Unit tests for classifyFixture and DEFAULT_LIVE_STATUS_IDS.
 *
 * classifyFixture is a pure function with no I/O — all tests are deterministic.
 * Priority order under test:
 *   1. hasOdds=false → 'skip'
 *   2. statusId in liveStatusIds → 'live'
 *   3. kickoff < MATCH_DURATION_MS ago (statusId lag) → 'live'
 *   4. kickoff ≥ MATCH_DURATION_MS ago (finished) → 'skip'
 *   5. kickoff within pregameWindowMs → 'pregame'
 *   6. everything else (far future) → 'skip'
 */

import { describe, it, expect } from 'vitest';
import {
	classifyFixture,
	DEFAULT_LIVE_STATUS_IDS,
} from '../services/sportsbook-arb-service.js';

// ── Shared test constants ─────────────────────────────────────────────────────

const NOW     = new Date('2026-07-20T15:00:00Z').getTime();
const LIVE_IDS = DEFAULT_LIVE_STATUS_IDS;  // [2, 3, 4, 5, 6]
const WINDOW  = 24 * 60 * 60 * 1000;      // 24 hours in ms

// MATCH_DURATION_MS is 2.5 hours (not exported), used in boundary tests below.
const MATCH_DURATION_MS = 2.5 * 60 * 60 * 1000;

/** Build a minimal fixture object for testing. */
function makeFixture(overrides: {
	statusId?: number;
	startTime?: string;
	hasOdds?: boolean;
}): { statusId: number; startTime: string; hasOdds: boolean } {
	return {
		statusId:  overrides.statusId  ?? 1,   // 1 = Not Started (pregame / scheduled)
		startTime: overrides.startTime ?? new Date(NOW).toISOString(),
		hasOdds:   overrides.hasOdds   ?? true,
	};
}

// ── DEFAULT_LIVE_STATUS_IDS ───────────────────────────────────────────────────

describe('DEFAULT_LIVE_STATUS_IDS', () => {
	it('contains exactly [2, 3, 4, 5, 6]', () => {
		expect(Array.from(DEFAULT_LIVE_STATUS_IDS)).toEqual([2, 3, 4, 5, 6]);
	});
});

// ── classifyFixture — 'live' cases ───────────────────────────────────────────

describe('classifyFixture', () => {
	describe("'live' tier", () => {
		it('returns live for statusId 2 (in-progress)', () => {
			const f = makeFixture({ statusId: 2, startTime: new Date(NOW - 30 * 60_000).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('live');
		});

		it('returns live for statusId 3 (halftime)', () => {
			const f = makeFixture({ statusId: 3, startTime: new Date(NOW - 50 * 60_000).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('live');
		});

		it('returns live for statusId 6 (penalties)', () => {
			const f = makeFixture({ statusId: 6, startTime: new Date(NOW - 110 * 60_000).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('live');
		});

		it('returns live for fixture that kicked off 30 min ago but statusId=1 (lag)', () => {
			// statusId=1 (Not Started) but kickoff was 30 min ago → OddsPapi lag → treat as live
			const f = makeFixture({
				statusId:  1,
				startTime: new Date(NOW - 30 * 60_000).toISOString(),
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('live');
		});

		it('returns live for fixture that kicked off 2h ago with statusId=1 (still within MATCH_DURATION_MS)', () => {
			// 2h = 7,200,000 ms < MATCH_DURATION_MS (9,000,000 ms) → still live
			const f = makeFixture({
				statusId:  1,
				startTime: new Date(NOW - 2 * 60 * 60_000).toISOString(),
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('live');
		});
	});

	// ── 'pregame' cases ───────────────────────────────────────────────────────

	describe("'pregame' tier", () => {
		it('returns pregame for fixture kicking off in 30 minutes', () => {
			const f = makeFixture({ statusId: 1, startTime: new Date(NOW + 30 * 60_000).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('pregame');
		});

		it('returns pregame for fixture kicking off in 23h 59m (just inside 24h window)', () => {
			const msUntil = 23 * 60 * 60_000 + 59 * 60_000;  // 23h 59m
			const f = makeFixture({ statusId: 1, startTime: new Date(NOW + msUntil).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('pregame');
		});
	});

	// ── 'skip' cases ──────────────────────────────────────────────────────────

	describe("'skip' tier", () => {
		it('returns skip for fixture kicking off in 25h (outside 24h window)', () => {
			const f = makeFixture({ statusId: 1, startTime: new Date(NOW + 25 * 60 * 60_000).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('skip');
		});

		it('returns skip for fixture that finished 3h ago (past MATCH_DURATION_MS)', () => {
			// 3h = 10,800,000 ms > MATCH_DURATION_MS (9,000,000 ms) → finished
			const f = makeFixture({
				statusId:  1,
				startTime: new Date(NOW - 3 * 60 * 60_000).toISOString(),
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('skip');
		});

		it('returns skip for hasOdds=false regardless of statusId', () => {
			// Even an in-progress fixture with no odds should be skipped.
			const f = makeFixture({ statusId: 2, hasOdds: false });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('skip');
		});

		it('returns skip for statusId=7 (finished) even if kickoff is recent', () => {
			// statusId=7 is NOT in liveStatusIds. If kickoff was 1h ago, the
			// kickoff-time fallback catches it as 'live' (within MATCH_DURATION_MS).
			// This is intentional: we poll once more for recently-finished fixtures
			// (they'll have no odds). But if kickoff was ≥ 2.5h ago, it's skipped.
			const f = makeFixture({
				statusId:  7,
				startTime: new Date(NOW - 3 * 60 * 60_000).toISOString(),  // 3h ago → skip
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('skip');
		});

		it('returns skip for statusId=8 (postponed) with kickoff far in the future', () => {
			// Postponed fixture — statusId=8, kickoff rescheduled far out.
			const f = makeFixture({
				statusId:  8,
				startTime: new Date(NOW + 7 * 24 * 60 * 60_000).toISOString(),
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('skip');
		});

		it('returns skip for far-future fixture (kickoff in 7 days)', () => {
			const f = makeFixture({ statusId: 1, startTime: new Date(NOW + 7 * 24 * 60 * 60_000).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('skip');
		});
	});

	// ── Boundary cases ────────────────────────────────────────────────────────

	describe('boundary conditions', () => {
		it('pregame at exactly pregameWindowMs boundary (kickoff in exactly 24h)', () => {
			// msUntilKickoff === pregameWindowMs → condition is <=, so this is pregame.
			const f = makeFixture({ statusId: 1, startTime: new Date(NOW + WINDOW).toISOString() });
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('pregame');
		});

		it('live at MATCH_DURATION_MS - 1ms boundary (just inside window)', () => {
			const f = makeFixture({
				statusId:  1,
				startTime: new Date(NOW - (MATCH_DURATION_MS - 1)).toISOString(),
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('live');
		});

		it('skip at exactly MATCH_DURATION_MS boundary (kickoff exactly 2.5h ago)', () => {
			// msUntilKickoff === -MATCH_DURATION_MS → condition is <=, so this is skip.
			const f = makeFixture({
				statusId:  1,
				startTime: new Date(NOW - MATCH_DURATION_MS).toISOString(),
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('skip');
		});

		it('liveStatusId=4 (Extra Time) is live regardless of kickoff time', () => {
			// Even if kickoff appears far enough back that time-based check would skip,
			// explicit liveStatusId=4 takes priority (checked before kickoff time).
			const f = makeFixture({
				statusId:  4,
				startTime: new Date(NOW - 4 * 60 * 60_000).toISOString(),  // 4h ago
			});
			expect(classifyFixture(f, NOW, LIVE_IDS, WINDOW)).toBe('live');
		});

		it('custom liveStatusIds override works correctly', () => {
			// statusId=2 is not in this custom list → uses kickoff-time fallback.
			const customLiveIds: readonly number[] = [10, 11, 12];
			const f = makeFixture({
				statusId:  2,
				startTime: new Date(NOW + 30 * 60_000).toISOString(),  // future → pregame
			});
			expect(classifyFixture(f, NOW, customLiveIds, WINDOW)).toBe('pregame');
		});
	});
});
