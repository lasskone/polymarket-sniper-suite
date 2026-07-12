/**
 * EventDetector — polls API-Football for real-time match events
 * (goals, red cards, half-time, full-time) and emits them for the
 * market-matcher to act on.
 */

export type MatchEventType = 'GOAL' | 'RED_CARD' | 'HALF_TIME' | 'FULL_TIME';

export interface MatchEvent {
  fixtureId: number;
  eventType: MatchEventType;
  team: string;
  minute: number;
  score: { home: number; away: number };
  detectedAt: Date;
}

export class EventDetector {
  private apiKey: string;
  private baseUrl = 'https://v3.football.api-sports.io';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getLiveFixtures(): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/fixtures?live=all`, {
      headers: { 'x-apisports-key': this.apiKey },
    });
    if (!res.ok) throw new Error(`API-Football error: ${res.status}`);
    const data = (await res.json()) as { response: Array<{ fixture: { id: number } }> };
    return data.response.map((f) => f.fixture.id);
  }

  async getFixtureEvents(fixtureId: number): Promise<MatchEvent[]> {
    const res = await fetch(`${this.baseUrl}/fixtures/events?fixture=${fixtureId}`, {
      headers: { 'x-apisports-key': this.apiKey },
    });
    if (!res.ok) throw new Error(`API-Football error: ${res.status}`);

    const data = (await res.json()) as {
      response: Array<{
        time: { elapsed: number };
        team: { name: string };
        type: string;
        detail: string;
        score?: { home: number; away: number };
      }>;
    };

    const events: MatchEvent[] = [];
    for (const e of data.response) {
      let eventType: MatchEventType | null = null;
      if (e.type === 'Goal') eventType = 'GOAL';
      else if (e.type === 'Card' && e.detail === 'Red Card') eventType = 'RED_CARD';

      if (eventType) {
        events.push({
          fixtureId,
          eventType,
          team: e.team.name,
          minute: e.time.elapsed,
          score: e.score ?? { home: 0, away: 0 },
          detectedAt: new Date(),
        });
      }
    }
    return events;
  }
}
