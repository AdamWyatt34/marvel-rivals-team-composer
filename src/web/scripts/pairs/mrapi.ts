/**
 * Minimal marvelrivalsapi.com client for match sampling (free tier,
 * x-api-key auth, 3k requests/day). Response shapes mirror the ones the old
 * .NET crawler consumed (see git history: MarvelRivalsApiClient.cs).
 */

const BASE_URL = "https://marvelrivalsapi.com";
const REQUEST_DELAY_MS = 600;
/** On 429, escalating backoff, up to MAX_RETRIES times. */
const RETRY_DEFAULT_MS = 30_000;
const RETRY_MAX_MS = 120_000;
const MAX_RETRIES = 3;

export class RateLimitedError extends Error {
  constructor() {
    super("marvelrivalsapi.com rate limit reached");
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
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: { "x-api-key": this.apiKey, Accept: "application/json" },
      });
      if (res.status === 404) return null;
      if (res.status === 429) {
        // Short-window limit; the Retry-After header is unreliable (says 1s
        // while the window is much longer), so back off on our own schedule.
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
   * Ask the API to (re)index a player. It 500s on match-history for players
   * it hasn't crawled yet; this queues them so future runs succeed.
   */
  async requestPlayerUpdate(uid: string): Promise<void> {
    try {
      await this.get(`/api/v1/player/${encodeURIComponent(uid)}/update`);
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      // indexing nudges are best-effort
    }
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
