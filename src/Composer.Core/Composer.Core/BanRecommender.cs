using Composer.Core.Models;

namespace Composer.Core;

public sealed class BanRecommender
{
    private readonly Composer _composer;
    private readonly List<string> _allHeroIds;

    public BanRecommender(Composer composer)
    {
        _composer = composer;
        _allHeroIds = composer.Pool.Select(h => h.Id).ToList();
    }

    // Suggest bans only if caller passes empty myBans. Symmetric ban model: a ban removes hero for both sides.
    public IReadOnlyList<string> SuggestBans(
        IEnumerable<string> myLocked, IEnumerable<string> enemyLocked,
        IEnumerable<string>? existingBans, TeamRules rules, int k = 3)
    {
        var banned = new HashSet<string>(existingBans ?? []);
        var candidates = _allHeroIds
            .Except(myLocked)
            .Except(enemyLocked)
            .Where(id => !banned.Contains(id))
            .ToArray();

        var baseBest = _composer.Compose(myLocked, enemyLocked, [], [], rules);

        var lifts = new List<(string id, double lift)>();
        foreach (var c in candidates)
        {
            var withBan = _composer.Compose(myLocked, enemyLocked, [c], [], rules);
            lifts.Add((c, withBan.score - baseBest.score)); // positive means banning c helps us
        }

        return lifts.OrderByDescending(x => x.lift).Take(k).Select(x => x.id).ToList();
    }
}