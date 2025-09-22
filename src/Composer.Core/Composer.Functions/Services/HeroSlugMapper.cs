using System.Text.RegularExpressions;
using Composer.Core.Models;


namespace Composer.Functions.Services;

public interface IHeroSlugMapper
{
    // Returns roster slug (e.g., "doctor-strange") or null
    string? FromIconPath(string? iconPath);
    // Optional: if you decide to map numeric ids
    string? FromNumericId(int heroId);
    string? FromSlug(string? slug);
}

public sealed partial class HeroSlugMapper : IHeroSlugMapper
{
    private readonly Roster _roster;
    private static readonly Regex FileSlug = MyRegex();

    // Optional static id->slug overrides (if some icons don’t follow the naming)
    private static readonly Dictionary<int,string> IdToSlug = new()
    {
        [1011] = "bruce-banner",
        [1014] = "the-punisher",
        [1015] = "storm",
        [1016] = "loki",
        [1017] = "human-torch",
        [1018] = "doctor-strange",
        [1020] = "mantis",
        [1021] = "hawkeye",
        [1022] = "captain-america",

        [1023] = "rocket-raccoon",
        [1024] = "hela",
        [1025] = "cloak-dagger",
        [1026] = "black-panther",
        [1027] = "groot",
        [1028] = "ultron",
        [1029] = "magik",
        [1030] = "moon-knight",
        [1031] = "luna-snow",
        [1032] = "squirrel-girl",
        [1033] = "black-widow",
        [1034] = "iron-man",
        [1035] = "venom",
        [1036] = "spider-man",
        [1037] = "magneto",
        [1038] = "scarlet-witch",

        [1039] = "thor",
        [1040] = "mister-fantastic",
        [1041] = "winter-soldier",
        [1042] = "peni-parker",
        [1043] = "star-lord",
        [1044] = "blade",
        [1045] = "namor",
        [1046] = "adam-warlock",
        [1047] = "jeff-the-land-shark",
        [1048] = "psylocke",

        [1049] = "wolverine",
        [1050] = "invisible-woman",
        [1051] = "the-thing",
        [1052] = "iron-fist",
        [1053] = "emma-frost",
        [1054] = "phoenix",
        [1056] = "angela"
    };

    public HeroSlugMapper(Roster roster) => _roster = roster;

    public string? FromIconPath(string? iconPath)
    {
        if (string.IsNullOrWhiteSpace(iconPath)) return null;
        var m = FileSlug.Match(iconPath);
        if (!m.Success) return null;
        var slug = m.Groups[1].Value.ToLowerInvariant();
        return _roster.Heroes.ContainsKey(slug) ? slug : null;
    }

    public string? FromNumericId(int heroId)
    {
        if (IdToSlug.TryGetValue(heroId, out var slug) && _roster.Heroes.ContainsKey(slug))
            return slug;
        return null;
    }

    public string? FromSlug(string? slug)
    {
        if (string.IsNullOrWhiteSpace(slug)) 
            return null;
        slug = slug.Trim().ToLowerInvariant();
        
        return _roster.Heroes.ContainsKey(slug) ? slug : null;
    }

    [GeneratedRegex(@"\/([a-z0-9-]+)-headbig", RegexOptions.IgnoreCase | RegexOptions.Compiled, "en-US")]
    private static partial Regex MyRegex();
}
