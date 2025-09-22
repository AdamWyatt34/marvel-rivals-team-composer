using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions.Services;

public interface IMarvelRivalsApi
{
    Task<PlayerLite?> ResolvePlayerAsync(string userOrUid, CancellationToken ct = default);
    Task<MatchHistoryPage> GetMatchHistoryAsync(string userOrUid, long? sinceEpoch = null, int page = 1, int limit = 40, CancellationToken ct = default);
    Task<MatchDetails?> GetMatchDetailsAsync(string matchUid, CancellationToken ct = default);
    Task RequestPlayerUpdateAsync(string userOrUid, CancellationToken ct = default);
    Task<List<HeroDto>> GetHeroesAsync(CancellationToken ct = default);
}

// -------- Implementation --------
public sealed class MarvelRivalsApi : IMarvelRivalsApi
{
    private readonly HttpClient _http;
    private readonly JsonSerializerOptions _json;

    public MarvelRivalsApi(HttpClient http)
    {
        _http = http;
        _json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
    }

    public async Task<PlayerLite?> ResolvePlayerAsync(string userOrUid, CancellationToken ct = default)
    {
        // If it’s all digits, treat as UID; else use username endpoint.
        // Replace with the exact endpoints your wrapper exposes.
        HttpResponseMessage resp;
        if (IsAllDigits(userOrUid))
        {
            resp = await _http.GetAsync($"/api/v1/find-player/{userOrUid}", ct);
        }
        else
        {
            var cleaned = CleanQuery(userOrUid);
            // search or username direct
            resp = await _http.GetAsync($"/api/v1/find-player/{Uri.EscapeDataString(cleaned)}", ct);
        }

        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        resp.EnsureSuccessStatusCode();

        var txt = await resp.Content.ReadAsStringAsync(ct);
        var doc = JsonDocument.Parse(txt);
        // Shape may vary by endpoint — adjust if needed.
        // Expecting something like { "player": { "player_uid": 123, "nick_name": "..." } }
        var root = doc.RootElement;
        if (root.TryGetProperty("player", out var p))
        {
            return new PlayerLite
            {
                PlayerUid = p.GetPropertyOrDefault<string>("uid"),
                NickName  = p.GetPropertyOrDefault<string>("name") ?? userOrUid
            };
        }
        // Fallback: direct fields
        return new PlayerLite
        {
            PlayerUid = root.GetPropertyOrDefault<string>("uid"),
            NickName  = root.GetPropertyOrDefault<string>("name") ?? userOrUid
        };
    }

    public async Task<MatchHistoryPage> GetMatchHistoryAsync(string userOrUid, long? sinceEpoch = null, int page = 1, int limit = 40, CancellationToken ct = default)
    {
        // Endpoint you specified:
        //   /api/v2/player/{userOrUid}/match-history?timestamp=<epoch>&page=&limit=&skip=
        // Some backends use 'since' instead of 'timestamp'. If so, swap it here.
        var qs = new List<string>();
        if (sinceEpoch is not null) qs.Add($"timestamp={sinceEpoch.Value}");
        if (page > 0) qs.Add($"page={page}");
        if (limit > 0) qs.Add($"limit={limit}");
        qs.Add("game_mode=2"); // competitive only
        
        var cleaned = CleanQuery(userOrUid);
        var path = $"/api/v2/player/{Uri.EscapeDataString(cleaned)}/match-history" + (qs.Count>0 ? "?" + string.Join("&", qs) : "");

        using var resp = await _http.GetAsync(path, ct);
        resp.EnsureSuccessStatusCode();
        var txt = await resp.Content.ReadAsStringAsync(ct);
        var res = JsonSerializer.Deserialize<MatchHistoryResponse>(txt, _json) ?? new MatchHistoryResponse();
        return new MatchHistoryPage
        {
            Items = res.match_history ?? [],
            Pagination = res.pagination ?? new Pagination()
        };
    }
    
    public async Task<MatchDetails?> GetMatchDetailsAsync(string matchUid, CancellationToken ct = default)
    {
        var path = $"/api/v1/match/{Uri.EscapeDataString(matchUid)}";
        using var resp = await _http.GetAsync(path, ct);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        resp.EnsureSuccessStatusCode();
        var txt = await resp.Content.ReadAsStringAsync(ct);
        var res = JsonSerializer.Deserialize<MatchDetailsResponse>(txt, _json);
        return res?.match_details;
    }
    
    public async Task RequestPlayerUpdateAsync(string userOrUid, CancellationToken ct = default)
    {
        var cleaned = CleanQuery(userOrUid);
        var path = $"/api/v1/player/{Uri.EscapeDataString(cleaned)}/update";
        using var resp = await _http.GetAsync(path, ct);
        // Some backends respond 202/200; accept both
        if (resp.StatusCode == HttpStatusCode.NotFound) return;
        resp.EnsureSuccessStatusCode();
    }

    public async Task<List<HeroDto>> GetHeroesAsync(CancellationToken ct = default)
    {
        var path = "/api/v1/heroes";
        using var resp = await _http.GetAsync(path, ct);
        resp.EnsureSuccessStatusCode();
        var txt = await resp.Content.ReadAsStringAsync(ct);
        var res = JsonSerializer.Deserialize<List<HeroDto>>(txt, _json) ?? [];
        return res;
    }

    private static bool IsAllDigits(string s) => Regex.IsMatch(s ?? "", @"^\d+$");
    
    private static string CleanQuery(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return string.Empty;
        // strip BOM + common zero-width marks + whitespace
        return s.Replace("\uFEFF", "")
            .Replace("\u200B", "")
            .Replace("\u200E", "")
            .Replace("\u200F", "")
            .Trim();
    }
}

// -------- Helpers + DTOs --------
internal static class JsonExt
{
    public static T? GetPropertyOrDefault<T>(this JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var v)) return default;
        try
        {
            if (typeof(T) == typeof(string)) return (T?)(object?)v.GetString();
            if (typeof(T) == typeof(int))    return (T?)(object?)v.GetInt32();
            if (typeof(T) == typeof(long))   return (T?)(object?)v.GetInt64();
            if (typeof(T) == typeof(double)) return (T?)(object?)v.GetDouble();
            if (typeof(T) == typeof(bool))   return (T?)(object?)v.GetBoolean();
        }
        catch { }
        return default;
    }
}

// ---------- DTOs you actually use ----------
public sealed class PlayerLite
{
    public string? PlayerUid { get; set; }
    public string? NickName { get; set; }
}

public sealed class MatchHistoryResponse
{
    public List<MatchHistoryItem>? match_history { get; set; }
    public Pagination? pagination { get; set; }
}
public sealed class MatchHistoryItem
{
    public string? match_uid { get; set; }
    public int game_mode_id { get; set; }       // 2 = Competitive (ranked)
    public long match_time_stamp { get; set; }  // epoch seconds
    public int match_winner_side { get; set; }  // 0 or 1
    public int match_map_id { get; set; }
    // ... add fields if you need them later
}
public sealed class Pagination
{
    public int page { get; set; }
    public int limit { get; set; }
    public int total_matches { get; set; }
    public int total_pages { get; set; }
    public bool has_more { get; set; }
}

public sealed class MatchDetailsResponse
{
    public MatchDetails? match_details { get; set; }
}
public sealed class MatchDetails
{
    public string match_uid { get; set; } = "";
    public GameMode game_mode { get; set; } = new();
    public long mvp_uid { get; set; }
    public long svp_uid { get; set; }
    public DynamicFields dynamic_fields { get; set; } = new();
    public List<MatchPlayer> match_players { get; set; } = [];
}
public sealed class GameMode { public int game_mode_id { get; set; } public string? game_mode_name { get; set; } }

public sealed class DynamicFields
{
    public List<BanPick>? ban_pick_info { get; set; }
}
public sealed class BanPick
{
    public int vote_type { get; set; }      // 1 = ban (based on your sample)
    public int is_pick { get; set; }        // 0 = ban, 1 = pick (from sample)
    public int hero_id { get; set; }
    public int battle_side { get; set; }    // 0 or 1
    // effect_battle_side, conf_id, etc. are available if you need
}

public sealed class MatchPlayer
{
    public long player_uid { get; set; }
    public string? nick_name { get; set; }
    public int camp { get; set; }           // 0 or 1
    public int cur_hero_id { get; set; }
    public int is_win { get; set; }         // 1 or 0
    public List<PlayerHero>? player_heroes { get; set; }
    public string? cur_hero_icon { get; set; } // "/heroes/transformations/xxx.webp"
}
public sealed class PlayerHero
{
    public int hero_id { get; set; }
    public double play_time { get; set; }
    public string? hero_icon { get; set; }
}

public class MatchHistoryPage
{
    public List<MatchHistoryItem> Items { get; set; } = [];
    public Pagination Pagination { get; set; } = new();
}

public sealed record HeroDto(
    string id,
    string name,
    string? role,
    List<Ability>? abilities
);

public sealed record Ability(
    long id,
    string name,
    bool? isCollab,
    string? description,
    List<AbilityAdditionalField>? additionalFields
);

public sealed class AbilityAdditionalField
{
    public string name { get; set; }
    
    [JsonPropertyName("Team-Up Bonus")]
    public string teamUpBonus { get; set; }
    
}