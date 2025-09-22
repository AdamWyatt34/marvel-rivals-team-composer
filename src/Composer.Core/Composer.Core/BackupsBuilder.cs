using Composer.Core.Models;

namespace Composer.Core;


public static class BackupsBuilder
{
    public static async Task<Dictionary<string, List<string>>> BuildBackups(
        IReadOnlyList<Hero> team,
        IReadOnlyList<Hero> fullPool,
        ITeamScorer scorer,
        IEnumerable<string> myLockedIds,
        IEnumerable<string> enemyLockedIds,
        ISet<string> bannedUnion,
        TeamRules rules,
        string? map,
        double tolerance = 0.05)
    {
        var teamIds     = team.Select(h => h.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var enemyLocked = new HashSet<string>(enemyLockedIds, StringComparer.OrdinalIgnoreCase);

        var pool = fullPool
            .Where(h => !bannedUnion.Contains(h.Id))
            .Where(h => !teamIds.Contains(h.Id))
            .ToList();

        // Resolve enemy list (ids already)
        var enemyIds = enemyLocked.ToList();

        var byRole = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);

        foreach (var role in Enum.GetValues<Role>())
        {
            var indices = Enumerable.Range(0, team.Count)
                .Where(i => team[i].PrimaryRole == role)
                .ToList();
            
            if (indices.Count == 0)
                continue;

            var candidates = pool.Where(h => h.PrimaryRole == role).ToList();
            if (candidates.Count == 0)
                continue;

            var scored = new List<(string id, double s)>();

            foreach (var idx in indices)
            {
                foreach (var c in candidates)
                {
                    var mutated = team.ToList();
                    mutated[idx] = c;

                    if (!Composer.MeetsHardRules(mutated, rules))
                        continue;

                    var s = await scorer.Score(mutated.Select(h => h.Id).ToList(), enemyIds, map);
                    scored.Add((c.Id, s));
                }
            }

            if (scored.Count == 0) 
                continue;

            var best   = scored.Max(x => x.s);
            var cutoff = best * (1.0 - tolerance);

            var keepIds = scored
                .Where(x => x.s >= cutoff)
                .OrderByDescending(x => x.s)
                .Select(x => x.id)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            if (keepIds.Count > 0)
                byRole[role.ToString()] = keepIds;
        }

        return byRole;
    }
}