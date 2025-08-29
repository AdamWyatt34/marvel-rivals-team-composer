using Composer.Core.Models;

namespace Composer.Core;


public static class BackupsBuilder
    {
        /// <summary>
        /// Returns backups per role as hero IDs, where each backup is within `tolerance`
        /// of the best single-slot swap score for that role.
        /// </summary>
        public static Dictionary<string, List<string>> BuildBackups(
            IReadOnlyList<Hero> team,
            double baseline,
            Composer composer,
            IEnumerable<string> myLockedIds,
            IEnumerable<string> enemyLockedIds,
            ISet<string> bannedUnion,
            TeamRules rules,
            double tolerance = 0.05)
        {
            var roster = composer.Pool.ToDictionary(h => h.Id, h => h, StringComparer.OrdinalIgnoreCase);

            var teamIds     = team.Select(h => h.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var myLocked    = new HashSet<string>(myLockedIds   ?? [], StringComparer.OrdinalIgnoreCase);
            var enemyLocked = new HashSet<string>(enemyLockedIds?? [], StringComparer.OrdinalIgnoreCase);

            // Eligible candidates: not banned, not on team, not enemy-locked
            var pool = roster.Values
                .Where(h => !bannedUnion.Contains(h.Id))
                .Where(h => !teamIds.Contains(h.Id))
                .Where(h => !enemyLocked.Contains(h.Id))
                .ToList();

            var byRole = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);

            foreach (var role in Enum.GetValues<Role>())
            {
                // Collect all team indices that have this role
                var indices = Enumerable.Range(0, team.Count)
                    .Where(i => team[i].PrimaryRole == role)
                    .ToList();

                if (indices.Count == 0) continue;

                // Try replacing each of those indices with every pool candidate of same role
                var scored = new List<(string id, double s)>();
                var candidates = pool.Where(h => h.PrimaryRole == role).ToList();
                if (candidates.Count == 0) continue;

                // If you want to include real enemy in the scoring, thread it in here.
                var emptyEnemy = Array.Empty<Hero>();

                foreach (var idx in indices)
                {
                    var currentId = team[idx].Id;

                    // Never propose a replacement if this slot is locked
                    if (myLocked.Contains(currentId)) continue;

                    foreach (var c in candidates)
                    {
                        var mutated = team.ToList();
                        mutated[idx] = c;

                        // Must meet minimum hard rules
                        if (!Composer.MeetsHardRules(mutated, rules)) continue;

                        var s = composer.Score(mutated, emptyEnemy, map: null);
                        scored.Add((c.Id, s));
                    }
                }

                if (scored.Count == 0) continue;

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