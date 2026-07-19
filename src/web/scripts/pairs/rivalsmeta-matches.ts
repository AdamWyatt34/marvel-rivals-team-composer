import { USER_AGENT } from "../ingest/rivalsmeta";

/**
 * Minimal client for RivalsMeta's unofficial player-match API — the same
 * endpoints its player pages call from the browser; no key needed. Response
 * shapes mirror the game's own API, which is why they're identical to the
 * marvelrivalsapi.com client this replaced (see git history: mrapi.ts) —
 * that service stopped serving match history in July 2026.
 */

const BASE_URL = "https://rivalsmeta.com/api";
const REQUEST_DELAY_MS = 600;
/** On 429, escalating backoff, up to MAX_RETRIES times. */
const RETRY_DEFAULT_MS = 30_000;
const RETRY_MAX_MS = 120_000;
const MAX_RETRIES = 3;

export class RateLimitedError extends Error {
  constructor() {
    super("rivalsmeta.com rate limit reached");
    this.name = "RateLimitedError";
  }
}

export class HttpError extends Error {
  constructor(
    path: string,
    public readonly status: number,
  ) {
    super(`${path} returned ${status}`);
    this.name = "HttpError";
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

export class RivalsMetaMatchClient {
  private requestsUsed = 0;

  constructor(private readonly maxRequests: number) {}

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
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (res.status === 404) return null;
      if (res.status === 429) {
        if (attempt >= MAX_RETRIES) throw new RateLimitedError();
        const waitMs = Math.min(RETRY_MAX_MS, RETRY_DEFAULT_MS * (attempt + 1));
        console.warn(
          `429 on ${path} — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) throw new HttpError(path, res.status);
      return (await res.json()) as T;
    }
  }

  /**
   * Competitive match history for a player, newest first — first page only;
   * the daily cadence means anything deeper is already in the seen-set.
   * hero_id=0 (all heroes) is required; omitting it 500s.
   */
  async matchHistory(uid: string, season: number): Promise<MatchHistoryItem[]> {
    const res = await this.get<MatchHistoryItem[]>(
      `/player-match-history/${encodeURIComponent(uid)}?skip=0&game_mode_id=2&hero_id=0&season=${season}`,
    );
    return (res ?? []).filter((m) => m.game_mode_id === 2);
  }

  async matchDetails(matchUid: string): Promise<MatchDetails | null> {
    return this.get<MatchDetails>(`/matches/${encodeURIComponent(matchUid)}`);
  }
}
