namespace Composer.Core.Models;

public sealed record Roster(
    IReadOnlyDictionary<string, Hero> Heroes,
    IReadOnlyDictionary<(string, string), double> Synergy,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, double>> Counters
);