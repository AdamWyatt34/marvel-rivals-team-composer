using System.Text.Json;
using Composer.Core.Models;

namespace Composer.Core;

public class RosterLoader : IRosterProvider
{
    public static Roster LoadFromFolder(string folder)
    {
        var heroes = JsonSerializer.Deserialize<List<HeroJson>>(File.ReadAllText(Path.Combine(folder, "heroes.json")))!;
        var synergy = JsonSerializer.Deserialize<List<PairJson>>(File.ReadAllText(Path.Combine(folder, "synergy.json")))!;
        var counters = JsonSerializer.Deserialize<List<CountersJson>>(File.ReadAllText(Path.Combine(folder, "counters.json")))!;

        var heroMap = heroes.ToDictionary(
            h => h.id,
            h => new Hero(h.id, h.name, Enum.Parse<Role>(h.role, ignoreCase: true), h.tags ?? []));

        var synergyMap = new Dictionary<(string, string), double>();
        foreach (var p in synergy)
            synergyMap[(p.pair[0], p.pair[1])] = p.score;

        var countersMap = counters.ToDictionary(
            c => c.hero,
            c => (IReadOnlyDictionary<string, double>) (c.counters ?? new Dictionary<string, double>()));
        
        return new Roster(heroMap, synergyMap, countersMap);
    }

    private sealed record HeroJson(string id, string name, string role, string[]? tags);
    private sealed record PairJson(string[] pair, double score, string? note);
    private sealed record CountersJson(string hero, Dictionary<string, double>? counters);
    private sealed record WeightsJson(double roleCoverage, double synergy, double counters, double antiSynergy, double mapMods, double banRisk, double prior);

    public Task<Roster> GetAsync(CancellationToken ct = default)
    {
        var folder = Path.Combine(AppContext.BaseDirectory, "meta");
        var roster = LoadFromFolder(folder);
        return Task.FromResult(roster);
    }
}