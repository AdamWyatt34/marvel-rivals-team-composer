namespace Composer.Core.Models;

public sealed class TeamRules
{
    public int MinStrategists { get; init; } = 2;
    public int MinVanguards   { get; init; } = 1;
    public int TeamSize       { get; init; } = 6;
}