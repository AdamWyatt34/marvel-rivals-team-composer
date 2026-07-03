/**
 * Minimal marvelrivalsapi.com client for match sampling (free tier,
 * x-api-key auth, 3k requests/day). Response shapes mirror the ones the old
 * .NET crawler consumed (see git history: MarvelRivalsApiClient.cs).
 */

const BASE_URL = "https://marvelrivalsapi.com";
const REQUEST_DELAY_MS = 250;

export class RateLimitedError extends Error {
  constructor() {
    super("marvelrivalsapi.com rate limit reached");
    this.name = "RateLimitedError";
  }
}

export interface MatchHistoryItem {
  match_uid: string;
  game_mode_id: number; // 2 = competitive
  match_time_stamp: number; // epoch seconds
}

export interface MatchPlayer {
  camp: number;
  cur_hero_id: number;
  is_win: number;
}

export interface MatchDetails {
  match_uid: string;
  match_players: MatchPlayer[];
}

export class MrApiClient {
  private requestsUsed = 0;

  constructor(
    private readonly apiKey: string,
    private readonly maxRequests: number,
  ) {}

  get used(): number {
    return this.requestsUsed;
  }

  get budgetLeft(): number {
    return this.maxRequests - this.requestsUsed;
  }

  private async get<T>(path: string): Promise<T | null> {
    if (this.budgetLeft <= 0) throw new RateLimitedError();
    this.requestsUsed++;
    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "x-api-key": this.apiKey, Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (res.status === 429) throw new RateLimitedError();
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return (await res.json()) as T;
  }

  /** Competitive match history for a player uid, newest first. */
  async matchHistory(
    uid: string,
    sinceEpoch?: number,
  ): Promise<MatchHistoryItem[]> {
    const since = sinceEpoch != null ? `&timestamp=${sinceEpoch}` : "";
    const res = await this.get<{ match_history?: MatchHistoryItem[] }>(
      `/api/v2/player/${encodeURIComponent(uid)}/match-history?game_mode=2&limit=40&page=1${since}`,
    );
    return (res?.match_history ?? []).filter((m) => m.game_mode_id === 2);
  }

  async matchDetails(matchUid: string): Promise<MatchDetails | null> {
    const res = await this.get<{ match_details?: MatchDetails }>(
      `/api/v1/match/${encodeURIComponent(matchUid)}`,
    );
    return res?.match_details ?? null;
  }
}
