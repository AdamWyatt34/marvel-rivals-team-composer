using System.Text.Json;
using System.Text.Json.Serialization;
using Composer.Core;
using Composer.Core.Models;
using Composer.Functions.Extensions;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Composer.Functions;

public sealed class ComposeFunction
{
    private readonly Composer.Core.Composer _composer;
    private readonly BanRecommender _banRecommender;
    private readonly IExplainer _explainer;
    private readonly Roster _roster;

    public ComposeFunction(Composer.Core.Composer composer, BanRecommender banRecommender, IExplainer explainer, Roster roster)
    {
        _composer = composer;
        _banRecommender = banRecommender;
        _explainer = explainer;
        _roster = roster;
    }

    public sealed record TeamRulesDto(int minStrategists = 2, int minVanguards = 1, int teamSize = 6);
    public sealed record ComposeRequest(
        string[] myLocked,
        string[] enemyLocked,
        string[]? myBans,
        string[]? enemyBans,
        string? map,
        TeamRulesDto? rules
    );

    public sealed record Lineup(string role, string hero);

    [Function("compose")]
    public async Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        ComposeRequest? input;
        try
        {
            input = await JsonSerializer.DeserializeAsync<ComposeRequest>(req.Body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (input is null) throw new Exception("Payload was null");
        }
        catch (Exception ex)
        {
            return await req.BadRequestAsync($"Invalid payload: {ex.Message}");
        }

        // Canonicalize ids and validate against roster so typos don't create weird states
        static string Canon(string s) => (s ?? "").Trim().ToLowerInvariant();

        string[] canonMyLocked    = (input.myLocked    ?? Array.Empty<string>()).Select(Canon).ToArray();
        string[] canonEnemyLocked = (input.enemyLocked ?? Array.Empty<string>()).Select(Canon).ToArray();
        string[] canonMyBans      = (input.myBans      ?? Array.Empty<string>()).Select(Canon).ToArray();
        string[] canonEnemyBans   = (input.enemyBans   ?? Array.Empty<string>()).Select(Canon).ToArray();

        var unknown =
            canonMyLocked.Where(id => !_roster.Heroes.ContainsKey(id))
            .Concat(canonEnemyLocked.Where(id => !_roster.Heroes.ContainsKey(id)))
            .Concat(canonMyBans.Where(id => id.Length > 0 && !_roster.Heroes.ContainsKey(id)))
            .Concat(canonEnemyBans.Where(id => id.Length > 0 && !_roster.Heroes.ContainsKey(id)))
            .Distinct()
            .ToArray();

        if (unknown.Length > 0)
        {
            return await req.BadRequestAsync(JsonSerializer.Serialize(new
            {
                error = "Unknown hero id(s)",
                ids = unknown,
                hint = "Call GET /api/heroes and use the 'id' values (e.g., 'spider-man', 'mr-fantastic')."
            }));
        }

        var rules = new TeamRules
        {
            MinStrategists = input.rules?.minStrategists ?? 2,
            MinVanguards   = input.rules?.minVanguards   ?? 1,
            TeamSize       = input.rules?.teamSize       ?? 6
        };

        // Union bans for downstream helpers (informational)
        var bannedUnion = canonMyBans.Concat(canonEnemyBans).ToHashSet(StringComparer.OrdinalIgnoreCase);

        try
        {
            var (team, score) = _composer.Compose(
                canonMyLocked,
                canonEnemyLocked,
                canonMyBans,
                canonEnemyBans,
                rules,
                input.map);

            var rawBackups = BackupsBuilder.BuildBackups(team, score, _composer,
                canonMyLocked, canonEnemyLocked, bannedUnion, rules, tolerance: 0.05);

            // normalize: drop heroes already in the primary team, pretty-print names, dedupe, cap to 3
            var teamIds = team.Select(h => h.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);

            var backups = rawBackups.ToDictionary(
                kv => kv.Key,
                kv => kv.Value
                    .Where(id => !teamIds.Contains(id))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Select(id => _roster.Heroes.TryGetValue(id, out var h) ? h.Name : id)
                    .Take(3)
                    .ToArray()
            );

            string[]? suggested = null;
            if (canonMyBans.Length == 0) // only suggest if caller didn't pass myBans
                suggested = _banRecommender.SuggestBans(canonMyLocked, canonEnemyLocked, bannedUnion, rules, k: 3).ToArray();

            var rationale = new ExplainPayload(
                Team: team.Select(h => h.Name).ToList(),
                Enemy: canonEnemyLocked.Select(id => _roster.Heroes.TryGetValue(id, out var hv) ? hv.Name : id).ToList(),
                Bans: bannedUnion.ToList(),
                KeySynergies: ExtractTopSynergies(team),
                KeyCounters: ExtractTopCounters(team, canonEnemyLocked),
                Score: score
            );
            string explanation;
            try { explanation = await _explainer.ToShortTextAsync(rationale); }
            catch { explanation = "Explanation unavailable (AI disabled or misconfigured)."; }

            var resp = new
            {
                primary = ToRoleAssignments(team),
                backups,
                suggestedBans = suggested,
                explanation
            };
            return await req.OkJsonAsync(resp);
        }
        catch (InvalidOperationException inv)
        {
            return await req.BadRequestAsync(JsonSerializer.Serialize(new
            {
                error = inv.Message,
                locked = canonMyLocked,
                enemyLocked = canonEnemyLocked,
                bans = bannedUnion.ToArray(),
                tips = new[]
                {
                    "Ensure ids match /api/heroes exactly (use hyphens, e.g., 'spider-man').",
                    "Locked heroes are never banned; enemy-locked heroes are excluded from your pool.",
                    "Role rules are minimums (>=), not exact caps."
                }
            }));
        }
    }

    private static List<Lineup> ToRoleAssignments(IReadOnlyList<Hero> team)
        => team.Select(h => new Lineup(h.PrimaryRole.ToString(), h.Name)).ToList();

    private List<string> ExtractTopSynergies(IReadOnlyList<Hero> team)
    {
        var pairs = new List<(string desc, double s)>();
        for (int i = 0; i < team.Count; i++)
        for (int j = i + 1; j < team.Count; j++)
        {
            var a = team[i]; var b = team[j];
            if (_roster.Synergy.TryGetValue((a.Id, b.Id), out var v) || _roster.Synergy.TryGetValue((b.Id, a.Id), out v))
                if (v > 0) pairs.Add(($"{a.Name}+{b.Name} ({v:+0.##;-0.##;0})", v));
        }
        return pairs.OrderByDescending(p => p.s).Take(3).Select(p => p.desc).ToList();
    }

    private List<string> ExtractTopCounters(IReadOnlyList<Hero> team, IEnumerable<string> enemyIds)
    {
        var list = new List<(string desc, double v)>();
        foreach (var a in team)
        foreach (var enemyId in enemyIds)
            if (_roster.Counters.TryGetValue(a.Id, out var m) && m.TryGetValue(enemyId, out var v) && v > 1.0)
                list.Add(($"{a.Name} vs {enemyId} ({v:0.##}x)", v));
        return list.OrderByDescending(x => x.v).Take(3).Select(x => x.desc).ToList();
    }
}