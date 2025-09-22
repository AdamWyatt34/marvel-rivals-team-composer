using System.Text.Json;
using Azure.Data.AppConfiguration;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Core;
using Composer.Core.Models;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions.Services;

public sealed class AzureRosterProvider : IRosterProvider
{
    private readonly IConfiguration _cfg;
    private (string version, Roster roster, DateTimeOffset expires)? _cache;

    public AzureRosterProvider(IConfiguration cfg) => _cfg = cfg;

    public async Task<Roster> GetAsync(CancellationToken ct = default)
    {
        if (_cache is { } hit && hit.expires > DateTimeOffset.UtcNow)
            return hit.roster;

        // Read settings HERE (not in ctor)
        var appConfigEndpointStr = _cfg["AppConfig__Endpoint"] ?? Environment.GetEnvironmentVariable("AppConfig__Endpoint");
        var blobEndpointStr      = _cfg["Storage__BlobEndpoint"] ?? Environment.GetEnvironmentVariable("Storage__BlobEndpoint");
        var container            = _cfg["Meta__ContainerName"] ?? "meta";
        var cacheMinutesStr      = _cfg["Meta__CacheMinutes"] ?? "60";

        if (string.IsNullOrWhiteSpace(appConfigEndpointStr) ||
            string.IsNullOrWhiteSpace(blobEndpointStr))
        {
            throw new InvalidOperationException(
                $"Missing config. AppConfig__Endpoint='{appConfigEndpointStr}', Storage__BlobEndpoint='{blobEndpointStr}'.");
        }

        var cacheFor = TimeSpan.FromMinutes(double.TryParse(cacheMinutesStr, out var m) ? m : 5);

        var appConfigEndpoint = new Uri(appConfigEndpointStr);
        var blobEndpoint      = new Uri(blobEndpointStr);

        var cred = new DefaultAzureCredential();

        // App Config
        var appc = new ConfigurationClient(appConfigEndpoint, cred);
        var versionSetting = await appc.GetConfigurationSettingAsync("meta.currentVersion", null, ct);
        var version = versionSetting.Value?.Value ?? "v1";

        // Blob
        var svc = new BlobServiceClient(blobEndpoint, cred);
        var cont = svc.GetBlobContainerClient(container);

        async Task<T> Read<T>(string name)
        {
            var blob = cont.GetBlobClient($"{version}/{name}");
            var dl = await blob.DownloadContentAsync(ct);
            return JsonSerializer.Deserialize<T>(
                dl.Value.Content.ToString(),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        }

        var heroes   = await Read<List<HeroJson>>("heroes.json");
        var synergy  = await Read<List<PairJson>>("synergy.json");
        var counters = await Read<List<CountersJson>>("counters.json");
        var w        = await Read<WeightsJson>("weights.json");

        var heroMap = heroes.ToDictionary(
            h => h.id,
            h => new Hero(h.id, h.name, Enum.Parse<Role>(h.role, ignoreCase: true), h.tags ?? []));

        var synergyMap = new Dictionary<(string,string), double>();
        foreach (var p in synergy) synergyMap[(p.pair[0], p.pair[1])] = p.score;

        var countersMap = counters.ToDictionary(
            c => c.hero,
            c => (IReadOnlyDictionary<string,double>)(c.counters ?? new Dictionary<string,double>()),
            StringComparer.Ordinal);

        var roster = new Roster(heroMap, synergyMap, countersMap);
        _cache = (version, roster, DateTimeOffset.UtcNow + cacheFor);
        return roster;
    }

    private sealed record HeroJson(string id, string name, string role, string[]? tags);
    private sealed record PairJson(string[] pair, double score, string? note);
    private sealed record CountersJson(string hero, Dictionary<string,double>? counters);
    private sealed record WeightsJson(double roleCoverage, double synergy, double counters, double antiSynergy, double mapMods, double banRisk, double prior);
}