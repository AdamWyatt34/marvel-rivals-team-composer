using Composer.Core.Models;

namespace Composer.Core;

public sealed class BanRecommender
{
    private readonly Composer _composer;
    private readonly ITeamScorer _scorer;
    private readonly List<string> _allHeroIds;
    private readonly IReadOnlyDictionary<string,double> _enemyImportance; // from model

    public BanRecommender(Composer composer, ITeamScorer scorer)
    {
        _composer = composer;
        _scorer   = scorer;
        _allHeroIds = composer.Pool.Select(h => h.Id).ToList();
        _enemyImportance = scorer.EnemyImportance;
    }

    /// <summary>
    /// Symmetric bans. Strategy:
    ///  1) Build an importance-driven candidate shortlist (drop our planned picks & already banned).
    ///  2) Adversarial-lite: for each candidate, recompute both sides' best teams with that ban applied and
    ///     keep the one that yields the highest model win prob. Repeat greedily for k steps.
    ///  3) If nothing improves, fallback to a threat heuristic that prefers counters to our current picks.
    /// </summary>
    public async Task<IReadOnlyList<string>> SuggestBans(
        IEnumerable<string> myLocked,
        IEnumerable<string> enemyLocked,
        IEnumerable<string>? existingBans,
        TeamRules rules,
        int k = 3,
        string? map = null,
        CancellationToken ct = default)
    {
        var mine    = new HashSet<string>(myLocked,    StringComparer.OrdinalIgnoreCase);
        var theirs  = new HashSet<string>(enemyLocked, StringComparer.OrdinalIgnoreCase);
        var banned  = new HashSet<string>(existingBans ?? [],StringComparer.OrdinalIgnoreCase);

        var chosen = new List<string>(capacity: k);

        for (var step = 0; step < k; step++)
        {
            // Compose our best team under current bans
            var (ourTeam, _) = await _composer.Compose(mine, theirs, banned, banned, rules, map);
            var ourIds = ourTeam.Select(h => h.Id).ToArray();
            var ourSet = ourIds.ToHashSet(StringComparer.OrdinalIgnoreCase);

            // Compose their best response to our current team
            var (theirTeam, _) = await _composer.Compose(theirs, ourIds, banned, banned, rules, map);
            var theirIds = theirTeam.Select(h => h.Id).ToArray();

            // Baseline probability
            var baseline = await _scorer.Score(ourIds, theirIds, map, ct);

            // --- Candidate shortlist (importance-driven, filtered) ---
            var baseCandidates = _allHeroIds
                .Where(id => !ourSet.Contains(id))
                .Where(id => !banned.Contains(id))
                .ToList();

            // If we have importances, rank by it; else just use all
            const int TOP_N = 14;
            var shortlist = (_enemyImportance.Count > 0
                    ? baseCandidates
                        .Select(id => (id, imp: _enemyImportance.GetValueOrDefault(id, 0.0)))
                        .OrderByDescending(t => t.imp)
                        .Select(t => t.id)
                        .ToList()
                    : baseCandidates)
                .Take(TOP_N)
                .ToList();

            if (shortlist.Count == 0) break;

            string? best = null;
            var bestProb = baseline;

            // Evaluate each candidate with recomposition for both sides
            foreach (var c in shortlist)
            {
                var testBans = new HashSet<string>(banned, StringComparer.OrdinalIgnoreCase) { c };

                var (ourTeam2, _)   = await _composer.Compose(mine, theirs, testBans, testBans, rules, map);
                var our2 = ourTeam2.Select(h => h.Id).ToArray();

                var (theirTeam2, _) = await _composer.Compose(theirs, our2, testBans, testBans, rules, map);
                var their2 = theirTeam2.Select(h => h.Id).ToArray();

                var p = await _scorer.Score(our2, their2, map, ct);
                if (!(p > bestProb + 1e-9))
                    continue;
                
                bestProb = p;
                best = c;
            }

            if (best is null)
            {
                // No improvement from shortlist — do a one-shot threat fallback, then stop.
                var fallback = ThreatFallback(ourIds, baseCandidates);
                if (fallback.Count > 0)
                    chosen.AddRange(fallback.Take(Math.Max(1, k - chosen.Count)));
                break;
            }

            banned.Add(best);
            chosen.Add(best);
        }

        return chosen;
    }

    // Simple counter-based threat ranking against our current team
    private List<string> ThreatFallback(string[] ourIds, List<string> candidates)
    {
        var threat = new Dictionary<string,double>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in candidates)
        {
            double t = 0;
            if (_composer.Roster.Counters.TryGetValue(c, out var vs))
            {
                foreach (var our in ourIds)
                    if (vs.TryGetValue(our, out var mult))
                        t = Math.Max(t, mult); // choose max multiplier; alternative: sum/avg
            }
            threat[c] = t;
        }
        return threat
            .OrderByDescending(kv => kv.Value)
            .Select(kv => kv.Key)
            .ToList();
    }
}
