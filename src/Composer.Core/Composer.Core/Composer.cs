using Composer.Core.Models;

namespace Composer.Core;

public sealed class Composer
{
    public readonly Roster Roster;
    private readonly ITeamScorer _scorer;
    private const double PriorTiebreak = 0.3;

    public Composer(IRosterProvider rosterProvider, ITeamScorer scorer)
    {
        Roster = rosterProvider.GetAsync().GetAwaiter().GetResult();
        _scorer = scorer;
    }

    public IReadOnlyList<Hero> Pool => Roster.Heroes.Values.ToList();

    public async Task<(IReadOnlyList<Hero> team, double score)> Compose(
        IEnumerable<string> myLockedIds,
        IEnumerable<string> enemyIds,
        IEnumerable<string> myBans,
        IEnumerable<string> enemyBans,
        TeamRules rules,
        string? map = null,
        int beamWidth = 32)
    {
        var banned = new HashSet<string>((myBans ?? [])
            .Concat(enemyBans), StringComparer.OrdinalIgnoreCase);

        var enemy = enemyIds.Where(id => Roster.Heroes.ContainsKey(id))
                            .Select(id => Roster.Heroes[id])
                            .ToList();

        var locked = myLockedIds.Select(id => Roster.Heroes[id]).ToList();

        // Exclude locked + banned + enemy-locked
        var pool = Roster.Heroes.Values
            .Where(h => !banned.Contains(h.Id))
            .Where(h => locked.All(l => l.Id != h.Id))
            .ToList();

        var startScoreRaw = await Score(locked, enemy, map);
        var startScore = AdjustWithPriors(startScoreRaw, locked);
        var beams = new List<(List<Hero> t, double s)> { ([..locked], startScore) };

        var completed = new List<(List<Hero> t, double s)>();

        while (beams.Count > 0 && beams[0].t.Count < rules.TeamSize)
        {
            var next = new List<(List<Hero>, double)>();

            foreach (var (t, _) in beams)
            {
                var slotsLeft = rules.TeamSize - t.Count;
                if (!StillFeasible(t, rules, pool, slotsLeft)) continue;

                var needStrat = Math.Max(0, rules.MinStrategists - t.Count(h => h.PrimaryRole == Role.Strategist));
                var needVang  = Math.Max(0, rules.MinVanguards   - t.Count(h => h.PrimaryRole == Role.Vanguard));

                var candidates = pool.Where(h => t.All(x => x.Id != h.Id));

                var priority = candidates.Where(h =>
                    (needStrat > 0 && h.PrimaryRole == Role.Strategist) ||
                    (needVang  > 0 && h.PrimaryRole == Role.Vanguard));

                var ordered = priority.Concat(candidates.Except(priority));

                foreach (var h in ordered)
                {
                    var nt = new List<Hero>(t) { h };

                    if (nt.Count == rules.TeamSize)
                    {
                        if (MeetsHardRules(nt, rules))
                        {
                            var raw = await Score(nt, enemy, map);
                            var adj = AdjustWithPriors(raw, nt);
                            completed.Add((nt, adj));
                        }
                        continue;
                    }
                    
                    var partialRaw = await Score(nt, enemy, map);
                    var partialAdj = AdjustWithPriors(partialRaw, nt);
                    next.Add((nt, partialAdj));
                }
            }

            if (next.Count == 0) break;
            beams = next.OrderByDescending(x => x.Item2).Take(beamWidth).ToList();
        }

        var finals = (completed.Count > 0 ? completed : beams)
            .Where(b => MeetsHardRules(b.t, rules))
            .ToList();

        return finals.Count == 0 ?
            throw new InvalidOperationException("No feasible team meets constraints with given locks & bans.") :
            finals.MaxBy(x => x.s);
    }

    private async Task<double> Score(IReadOnlyList<Hero> team, IReadOnlyList<Hero> enemy, string? map)
        => await _scorer.Score(team.Select(h => h.Id).ToList(), enemy.Select(h => h.Id).ToList(), map);

    public static bool MeetsHardRules(IReadOnlyList<Hero> team, TeamRules rules)
    {
        var strategists = team.Count(h => h.PrimaryRole == Role.Strategist);
        var vanguards   = team.Count(h => h.PrimaryRole == Role.Vanguard);
        return strategists >= rules.MinStrategists
            && vanguards   >= rules.MinVanguards
            && team.Count  == rules.TeamSize;
    }

    private static bool StillFeasible(List<Hero> partial, TeamRules rules, IEnumerable<Hero> pool, int slotsLeft)
    {
        var haveStrat = partial.Count(h => h.PrimaryRole == Role.Strategist);
        var needStrat = Math.Max(0, rules.MinStrategists - haveStrat);
        var haveVang  = partial.Count(h => h.PrimaryRole == Role.Vanguard);
        var needVang  = Math.Max(0, rules.MinVanguards - haveVang);

        var stratAvail = pool.Count(h => h.PrimaryRole == Role.Strategist && partial.All(p => p.Id != h.Id));
        var vangAvail  = pool.Count(h => h.PrimaryRole == Role.Vanguard   && partial.All(p => p.Id != h.Id));

        return needStrat <= stratAvail && needVang <= vangAvail && slotsLeft >= needStrat + needVang;
    }
    
    private double AdjustWithPriors(double pWin, IEnumerable<Hero> team)
    {
        if (_scorer.TryGetHeroPriors(out var priors))
        {
            var sum = 0.0;
            foreach (var h in team)
                if (priors.TryGetValue(h.Id, out var v)) sum += v;
            return pWin + PriorTiebreak * sum;
        }
        return pWin;
    }

}