using Composer.Core.Models;

namespace Composer.Core;

public sealed class Composer
{
    private readonly Roster _r;

    public Composer(IRosterProvider rosterProvider) => _r = rosterProvider.GetAsync().GetAwaiter().GetResult();

    public IReadOnlyList<Hero> Pool => _r.Heroes.Values.ToList();

    public (IReadOnlyList<Hero> team, double score) Compose(
        IEnumerable<string> myLockedIds,
        IEnumerable<string> enemyIds,
        IEnumerable<string> myBans,
        IEnumerable<string> enemyBans,
        TeamRules rules,
        string? map = null,
        int beamWidth = 32) // widen a bit
    {
        var banned = new HashSet<string>((myBans ?? []).Concat(enemyBans ?? []));
        var locked = myLockedIds.Select(id => _r.Heroes[id]).ToList();
        var enemy  = enemyIds.Where(id => _r.Heroes.ContainsKey(id)).Select(id => _r.Heroes[id]).ToList();

        // Exclude locked + banned + enemy-locked from our pick pool
        var enemyIdsSet = enemy.Select(e => e.Id).ToHashSet();
        var pool = _r.Heroes.Values
            .Where(h => !banned.Contains(h.Id) && !enemyIdsSet.Contains(h.Id) && locked.All(l => l.Id != h.Id))
            .ToList();

        var beams = new List<(List<Hero> t, double s)> { ([..locked], Score(locked, enemy, map)) };
        var completed = new List<(List<Hero> t, double s)>(); // ✅ collect complete teams

        while (beams.Count > 0 && beams[0].t.Count < rules.TeamSize)
        {
            var next = new List<(List<Hero>, double)>();

            foreach (var (t, _) in beams)
            {
                var slotsLeft = rules.TeamSize - t.Count;
                if (!StillFeasible(t, rules, pool, slotsLeft)) continue;

                var needStrat = Math.Max(0, rules.MinStrategists - t.Count(h => h.PrimaryRole == Role.Strategist));
                var needVang  = Math.Max(0, rules.MinVanguards   - t.Count(h => h.PrimaryRole == Role.Vanguard));

                IEnumerable<Hero> candidates = pool.Where(h => t.All(x => x.Id != h.Id));

                var priority = candidates.Where(h =>
                    (needStrat > 0 && h.PrimaryRole == Role.Strategist) ||
                    (needVang  > 0 && h.PrimaryRole == Role.Vanguard));

                var rest = candidates.Except(priority);

                candidates = priority.Concat(rest)
                    .OrderByDescending(TierWeight); // small tier bias

                foreach (var h in candidates)
                {
                    var nt = new List<Hero>(t) { h };
                    if (nt.Count == rules.TeamSize)
                    {
                        if (MeetsHardRules(nt, rules))
                            completed.Add((nt, Score(nt, enemy, map))); // ✅ keep it
                        continue;
                    }
                    next.Add((nt, Score(nt, enemy, map)));
                }
            }

            if (next.Count == 0) break;
            beams = next.OrderByDescending(x => x.Item2).Take(beamWidth).ToList();
        }

        // ✅ prefer completed teams if any
        var finals = (completed.Count > 0 ? completed : beams).Where(b => MeetsHardRules(b.t, rules)).ToList();
        if (finals.Count == 0)
            throw new InvalidOperationException("No feasible team meets constraints with given locks & bans.");

        return finals.MaxBy(x => x.s);
    }

    private double TierWeight(Hero h)
    {
        // Honor your tier tags without forcing picks:
        // S=1.0, A=0.8, B=0.5, C=0.2, D=0.0 (tweak)
        var tag = h.Tags?.FirstOrDefault(t => t.StartsWith("tier:"))?.Split(':')[1]?.ToUpperInvariant();
        return tag switch { "S" => 1.0, "A" => 0.8, "B" => 0.5, "C" => 0.2, _ => 0.0 };
    }

    public double Score(IReadOnlyList<Hero> team, IReadOnlyList<Hero> enemy, string? map)
    {
        double s = 0;
        s += _r.Weights.RoleCoverage * RoleCoverage(team);
        s += _r.Weights.Synergy     * SumPairwise(team, _r.Synergy);
        s += _r.Weights.Counters    * SumVsEnemy(team, enemy, _r.Counters);
        s += _r.Weights.Prior       * team.Sum(h => _r.Priors.GetValueOrDefault(h.Id, 0.0));
        return s;
    }

    private static double RoleCoverage(IReadOnlyList<Hero> team)
    {
        // simple coverage: reward diversity across base roles
        var roles = team.Select(h => h.PrimaryRole).Distinct().Count();
        return roles / 6.0;
    }

    private static double SumPairwise(IReadOnlyList<Hero> team, IReadOnlyDictionary<(string, string), double> S)
        => team.SelectMany((a, i) => team.Skip(i + 1).Select(b =>
            S.TryGetValue((a.Id, b.Id), out var v) ? v :
                S.GetValueOrDefault((b.Id, a.Id), 0))).Sum();

    private static double SumVsEnemy(IReadOnlyList<Hero> team, IReadOnlyList<Hero> enemy,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, double>> C)
        => (from a in team
            from e in enemy
            select C.TryGetValue(a.Id, out var m) && m.TryGetValue(e.Id, out var v) ? v - 1.0 : 0.0).Sum();

    public static bool MeetsHardRules(IReadOnlyList<Hero> team, TeamRules rules)
    {
        var strategists = team.Count(h => h.PrimaryRole == Role.Strategist);
        var vanguards   = team.Count(h => h.PrimaryRole == Role.Vanguard);
        return strategists >= rules.MinStrategists
               && vanguards   >= rules.MinVanguards
               && team.Count  == rules.TeamSize;
    }

    public static bool StillFeasible(List<Hero> partial, TeamRules rules, IEnumerable<Hero> pool, int slotsLeft)
    {
        var haveStrat = partial.Count(h => h.PrimaryRole == Role.Strategist);
        var needStrat = Math.Max(0, rules.MinStrategists - haveStrat);
        var haveVang  = partial.Count(h => h.PrimaryRole == Role.Vanguard);
        var needVang  = Math.Max(0, rules.MinVanguards - haveVang);

        var stratAvail = pool.Count(h => h.PrimaryRole == Role.Strategist && !partial.Any(p => p.Id == h.Id));
        var vangAvail  = pool.Count(h => h.PrimaryRole == Role.Vanguard   && !partial.Any(p => p.Id == h.Id));

        return needStrat <= stratAvail && needVang <= vangAvail && slotsLeft >= (needStrat + needVang);
    }
}