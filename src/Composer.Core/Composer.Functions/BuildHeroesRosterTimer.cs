using System.Text.Json;
using Azure.Data.AppConfiguration;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Functions.Services;
using Composer.Functions.Utilities;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Composer.Functions;

public sealed class BuildHeroesRosterTimer
{
    private readonly ILogger<BuildHeroesRosterTimer> _log;
    private readonly IConfiguration _cfg;
    private readonly IMarvelRivalsApi _api;
    private readonly IHeroSlugMapper _slug;
    private readonly BlobContainerClient _meta;   // meta outputs
    private readonly BlobContainerClient _models; // models/latest/gbdt_model.json(.gz)

    public BuildHeroesRosterTimer(
        ILogger<BuildHeroesRosterTimer> log,
        IConfiguration cfg,
        IMarvelRivalsApi api,
        IHeroSlugMapper slug)
    {
        _log  = log;
        _cfg  = cfg;
        _api  = api;
        _slug = slug;

        var blobEndpoint = _cfg["Storage:BlobEndpoint"] ?? _cfg["Storage__BlobEndpoint"]
                           ?? _cfg["Data:BlobEndpoint"] ?? _cfg["Data__BlobEndpoint"]
                           ?? Environment.GetEnvironmentVariable("Storage__BlobEndpoint")
                           ?? Environment.GetEnvironmentVariable("Data__BlobEndpoint")
                           ?? throw new InvalidOperationException("Blob endpoint not configured");

        var metaContainer   = _cfg["Meta:ContainerName"] ?? _cfg["Meta__ContainerName"] ?? "meta";
        var modelsContainer = _cfg["Models:ContainerName"] ?? _cfg["Models__ContainerName"] ?? "models";

        var svc = new BlobServiceClient(new Uri(blobEndpoint), new DefaultAzureCredential());
        _meta   = svc.GetBlobContainerClient(metaContainer);
        _models = svc.GetBlobContainerClient(modelsContainer);
    }

    private sealed record HeroOut(string id, string name, string role, string[] tags);

    [Function("build-heroes-roster")]
    public async Task Run([TimerTrigger("0 12 3 * * *")] TimerInfo _, CancellationToken ct)
    {
        var version = await ResolveVersionAsync(ct);
        _log.LogInformation("Building heroes.json for version {Version}", version);

        // 1) Fetch heroes from game API
        var heroes = await _api.GetHeroesAsync(ct);
        if (heroes.Count == 0)
        {
            _log.LogWarning("No heroes returned from API");
            return;
        }

        // 2) Load model importance for tier tags (optional but recommended)
        var imp = await TryReadEnemyImportanceAsync(ct); // hero -> gain
        var tierTag = imp?.Count > 0 ? BuildTierMap(imp) : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // 3) Build roster records
        var outList = new List<HeroOut>(heroes.Count);
        foreach (var h in heroes)
        {
            // Map numeric id -> slug id you use everywhere
            var id = TryMapId(h.id) ?? _slug.FromSlug(h.name) ?? Slug(h.name);
            var role = NormalizeRole(h.role);

            // tags: include a tier if we have importance; keep room for future tags
            var tags = new List<string>(2);
            if (tierTag.TryGetValue(id, out var tier))
                tags.Add($"tier:{tier}");

            outList.Add(new HeroOut(id, h.name, role, tags.ToArray()));
        }

        // 4) Write heroes.json
        await _meta.CreateIfNotExistsAsync(cancellationToken: ct);
        var json = JsonSerializer.Serialize(outList, new JsonSerializerOptions { WriteIndented = false });
        await _meta.GetBlobClient($"{version}/heroes.json")
                   .UploadAsync(BinaryData.FromString(json), overwrite: true, cancellationToken: ct);

        _log.LogInformation("Wrote heroes.json with {Count} heroes", outList.Count);
    }

    // ---------------- helpers ----------------

    private async Task<string> ResolveVersionAsync(CancellationToken ct)
    {
        // Prefer AppConfig meta.currentVersion; fallback to Meta__Version / "v1"
        var appcEndpoint = _cfg["AppConfig:Endpoint"] ?? _cfg["AppConfig__Endpoint"];
        if (!string.IsNullOrWhiteSpace(appcEndpoint))
        {
            try
            {
                var cli = new ConfigurationClient(new Uri(appcEndpoint!), new DefaultAzureCredential());
                var cs  = await cli.GetConfigurationSettingAsync("meta.currentVersion", null, ct);
                if (cs?.Value?.Value is { Length: > 0 } v) return v;
            }
            catch { /* fall through */ }
        }
        return _cfg["Meta:Version"] ?? _cfg["Meta__Version"] ?? "v1";
    }

    private async Task<Dictionary<string,double>?> TryReadEnemyImportanceAsync(CancellationToken ct)
    {
        try
        {
            // Read latest/gbdt_model.json or .json.gz and parse schema.importance_enemy
            var json = await DownloadModelJsonAsync(ct);
            using var doc = JsonDocument.Parse(json);
            var root   = doc.RootElement;
            if (!root.TryGetProperty("schema", out var schema)) return null;
            if (!schema.TryGetProperty("importance_enemy", out var imp) || imp.ValueKind != JsonValueKind.Object) return null;

            var dict = new Dictionary<string,double>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in imp.EnumerateObject())
                if (kv.Value.ValueKind == JsonValueKind.Number)
                    dict[kv.Name] = kv.Value.GetDouble();
            return dict;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to read importance from model; tiers will be omitted");
            return null;
        }
    }

    private async Task<string> DownloadModelJsonAsync(CancellationToken ct)
    {
        var blobJson = _models.GetBlobClient("latest/gbdt_model.json");
        if (await blobJson.ExistsAsync(ct))
        {
            var dl = await blobJson.DownloadContentAsync(ct);
            return dl.Value.Content.ToString();
        }
        var blobGz = _models.GetBlobClient("latest/gbdt_model.json.gz");
        var txt = await BlobText.DownloadTextMaybeGzipAsync(_models, blobGz, ct);
        return txt;
    }

    private static Dictionary<string,string> BuildTierMap(Dictionary<string,double> imp)
    {
        // Convert raw gains into S/A/B/C/D using quantiles (simple, stable)
        // You can tune these cutpoints.
        var vals = imp.Values.Where(v => v > 0).OrderBy(v => v).ToArray();
        if (vals.Length == 0) return new(StringComparer.OrdinalIgnoreCase);

        double Q(double p) => vals[(int)Math.Clamp(Math.Round(p * (vals.Length - 1)), 0, vals.Length - 1)];

        var cutS = Q(0.90); // top 10%
        var cutA = Q(0.70);
        var cutB = Q(0.45);
        var cutC = Q(0.20);

        string Bucket(double v)
        {
            if (v >= cutS) return "s";
            if (v >= cutA) return "a";
            if (v >= cutB) return "b";
            if (v >= cutC) return "c";
            return "d";
        }

        var tiers = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (k, v) in imp)
            tiers[k] = Bucket(v);
        return tiers;
    }

    private string? TryMapId(string? numericId)
    {
        if (!int.TryParse(numericId, out var n)) return null;
        return _slug.FromNumericId(n);
    }

    private static string NormalizeRole(string? role)
    {
        role = (role ?? "").Trim();
        return role.Equals("Strategist", StringComparison.OrdinalIgnoreCase) ? "Strategist"
             : role.Equals("Vanguard",   StringComparison.OrdinalIgnoreCase) ? "Vanguard"
             : "Duelist"; // default
    }

    private static string Slug(string name)
        => name.Trim().ToLowerInvariant().Replace(' ', '-');
}
