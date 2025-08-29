using System.Text.Json;
using Composer.Core.Models;

namespace Composer.Core;

public static class RosterLoader
{
    public static Roster LoadFromFolder(string folder)
    {
        var heroes = JsonSerializer.Deserialize<List<HeroJson>>(File.ReadAllText(Path.Combine(folder, "heroes.json")))!;
        var synergy = JsonSerializer.Deserialize<List<PairJson>>(File.ReadAllText(Path.Combine(folder, "synergy.json")))!;
        var counters = JsonSerializer.Deserialize<List<CountersJson>>(File.ReadAllText(Path.Combine(folder, "counters.json")))!;
        var w = JsonSerializer.Deserialize<WeightsJson>(File.ReadAllText(Path.Combine(folder, "weights.json")))!;

        var heroMap = heroes.ToDictionary(
            h => h.id,
            h => new Hero(h.id, h.name, Enum.Parse<Role>(h.role, ignoreCase: true), h.tags ?? Array.Empty<string>()));

        var synergyMap = new Dictionary<(string, string), double>();
        foreach (var p in synergy)
            synergyMap[(p.pair[0], p.pair[1])] = p.score;

        var countersMap = counters.ToDictionary(
            c => c.hero,
            c => (IReadOnlyDictionary<string, double>) (c.counters ?? new Dictionary<string, double>()));

        var weights = new Weights(w.roleCoverage, w.synergy, w.counters, w.antiSynergy, w.mapMods, w.banRisk, w.prior);

        var priors = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var h in heroes)
        {
            double p = 0.0;
            if (h.tags is not null)
                foreach (var tag in h.tags)
                    p = Math.Max(p, TierToPrior(tag));
            priors[h.id] = p;
        }
        
        return new Roster(heroMap, synergyMap, countersMap, weights, priors);
    }
    
    private static double TierToPrior(string tag) => tag switch
    {
        "tier:S" => 1.00,
        "tier:A" => 0.60,
        "tier:B" => 0.30,
        "tier:C" => 0.00,
        "tier:D" => 0.00,
        _ => 0.00
    };

    private sealed record HeroJson(string id, string name, string role, string[]? tags);
    private sealed record PairJson(string[] pair, double score, string? note);
    private sealed record CountersJson(string hero, Dictionary<string, double>? counters);
    private sealed record WeightsJson(double roleCoverage, double synergy, double counters, double antiSynergy, double mapMods, double banRisk, double prior);
}