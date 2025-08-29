namespace Composer.Core.Models;

public sealed record Weights(
    double RoleCoverage,
    double Synergy,
    double Counters,
    double AntiSynergy,
    double MapMods,
    double BanRisk,
    double Prior  
);