using System.Text.Json;
using Azure.Data.AppConfiguration;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Core.Models;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions.Services;

public interface IRosterProvider
{
    Task<Roster> GetAsync(CancellationToken ct = default);
}

public sealed class AzureRosterProvider : IRosterProvider
{
    private readonly Uri _appConfigEndpoint;
    private readonly Uri _blobEndpoint;     // e.g., https://stxxxx.blob.core.windows.net
    private readonly string _container;     // "meta"
    private readonly TimeSpan _cacheFor;
    private readonly IConfiguration _cfg;

    private (string version, Roster roster, DateTimeOffset expires)? _cache;

    public AzureRosterProvider(IConfiguration cfg)
    {
        _cfg = cfg;
        _appConfigEndpoint = new Uri(cfg["AppConfig__Endpoint"] ?? throw new InvalidOperationException("AppConfig__Endpoint missing"));
        _blobEndpoint      = new Uri(cfg["Storage__BlobEndpoint"] ?? throw new InvalidOperationException("Storage__BlobEndpoint missing"));
        _container         = cfg["Meta__ContainerName"] ?? "meta";
        _cacheFor          = TimeSpan.FromMinutes(double.TryParse(cfg["Meta__CacheMinutes"], out var m) ? m : 5);
    }

    public async Task<Roster> GetAsync(CancellationToken ct = default)
    {
        if (_cache is { } hit && hit.expires > DateTimeOffset.UtcNow)
            return hit.roster;

        var cred = new DefaultAzureCredential();

        // 1) Read active meta version from App Config
        var appc = new ConfigurationClient(_appConfigEndpoint, cred);
        var versionSetting = await appc.GetConfigurationSettingAsync("meta.currentVersion", null, ct);
        string version = versionSetting.Value?.Value ?? "v1";

        // 2) Read JSON files from Blob: meta/{version}/*.json
        var svc  = new BlobServiceClient(_blobEndpoint, cred);
        var container = svc.GetBlobContainerClient(_container);

        async Task<T> Read<T>(string name)
        {
            var blob = container.GetBlobClient($"{version}/{name}");
            var dl = await blob.DownloadContentAsync(ct);
            return JsonSerializer.Deserialize<T>(dl.Value.Content.ToString(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        }

        var heroes   = await Read<List<HeroJson>>("heroes.json");
        var synergy  = await Read<List<PairJson>>("synergy.json");
        var counters = await Read<List<CountersJson>>("counters.json");
        var w        = await Read<WeightsJson>("weights.json");

        var heroMap = heroes.ToDictionary(
            h => h.id,
            h => new Hero(h.id, h.name, Enum.Parse<Role>(h.role, ignoreCase: true), h.tags ?? Array.Empty<string>()));

        var synergyMap = new Dictionary<(string,string), double>();
        foreach (var p in synergy) synergyMap[(p.pair[0], p.pair[1])] = p.score;

        var countersMap = counters.ToDictionary(
            c => c.hero,
            c => (IReadOnlyDictionary<string,double>)(c.counters ?? new Dictionary<string,double>()));

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
        
        var roster = new Roster(heroMap, synergyMap, countersMap, weights, priors);

        _cache = (version, roster, DateTimeOffset.UtcNow + _cacheFor);
        return roster;
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
    private sealed record CountersJson(string hero, Dictionary<string,double>? counters);
    private sealed record WeightsJson(double roleCoverage, double synergy, double counters, double antiSynergy, double mapMods, double banRisk, double prior);
}