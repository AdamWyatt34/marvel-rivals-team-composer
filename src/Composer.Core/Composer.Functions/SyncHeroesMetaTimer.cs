using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Composer.Functions;

public sealed class SyncHeroesMetaTimer
{
    private readonly ILogger<SyncHeroesMetaTimer> _log;
    private readonly IConfiguration _cfg;
    private readonly IMarvelRivalsApi _marvelRivalsApi;
    private readonly IHeroSlugMapper _heroSlugMapper;
    private readonly BlobContainerClient _meta;

    public SyncHeroesMetaTimer(ILogger<SyncHeroesMetaTimer> log, IConfiguration cfg, IMarvelRivalsApi marvelRivalsApi, IHeroSlugMapper heroSlugMapper)
    {
        _log = log; 
        _cfg = cfg;
        _marvelRivalsApi = marvelRivalsApi;
        _heroSlugMapper = heroSlugMapper;
        var uri = _cfg["Data:BlobEndpoint"] 
                  ?? _cfg["Data__BlobEndpoint"]
                  ?? Environment.GetEnvironmentVariable("Data_BlobEndpoint")
                    ?? throw new InvalidOperationException("Missing Data:BlobEndpoint configuration");
        var svc = new BlobServiceClient(new Uri(uri), new DefaultAzureCredential());
        _meta = svc.GetBlobContainerClient(_cfg["Meta:ContainerName"] ?? "meta");
    }

    [Function("sync-heroes-meta")]
    public async Task Run([TimerTrigger("0 5 3 * * *")] TimerInfo _, CancellationToken ct)
    {
        var version = _cfg["Meta__Version"] ?? "v1";

        var heroes = await _marvelRivalsApi.GetHeroesAsync(ct);
        if (heroes.Count == 0)
        {
            _log.LogWarning("No heroes returned");
            return;
        }

        // Save compact dictionary: id -> { name, teamups[], role, topAbility }
        var map = new Dictionary<string, HeroBlurb>(StringComparer.OrdinalIgnoreCase);

        foreach (var h in heroes)
        {
            var id = _heroSlugMapper.FromNumericId(int.Parse(h.id));
            var role = h.role ?? "";

            var collabNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var collabLabels = new List<string>();

            foreach (var ab in h.abilities?.Where(a => a.additionalFields?.Count > 0) ?? [])
            {
                if (ab.isCollab != true) 
                    continue;
                
                if (!string.IsNullOrWhiteSpace(ab.name))
                    collabLabels.Add(ab.name);

                var desc = ab.description ?? "";
                // very lenient: pick capitalized words likely to be hero names; filter out the hero himself
                foreach (Match m in Regex.Matches(desc, @"\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\b"))
                {
                    var cand = m.Value.Trim();
                    if (!cand.Equals(h.name, StringComparison.OrdinalIgnoreCase) && _heroSlugMapper.FromSlug(cand) != null)
                        collabNames.Add(cand);
                }
            }

            map[id] = new HeroBlurb(h.name, role, collabNames.ToArray(), collabLabels.Take(3).ToArray());
        }

        await _meta.CreateIfNotExistsAsync(cancellationToken: ct);
        var json = JsonSerializer.Serialize(map);
        await _meta.GetBlobClient($"{version}/heroes-enriched.json")
                   .UploadAsync(BinaryData.FromString(json), overwrite: true, cancellationToken: ct);

        _log.LogInformation("Wrote heroes-enriched.json ({N} heroes)", map.Count);
    }

    private static string Slug(string s) => s.Trim().ToLowerInvariant().Replace(' ', '-');
    
    private sealed record HeroBlurb(
        string name,
        string role,
        string[] collabPartners,
        string[] collabLabels
    );

}