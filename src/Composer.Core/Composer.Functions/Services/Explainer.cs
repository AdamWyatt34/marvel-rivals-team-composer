using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Functions.Utilities;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions.Services;

public interface IExplainer
{
    Task<string> ToShortTextAsync(ExplainPayload p, CancellationToken ct = default);
}

public sealed class Explainer : IExplainer
{
    private readonly HttpClient _http;
    private readonly string _endpoint;
    private readonly string _apiKey;
    private readonly string _deployment;
    private readonly string _apiVersion;
    private readonly IConfiguration _cfg;
    private readonly IMemoryCache _cache;

    public Explainer(IConfiguration cfg, IHttpClientFactory httpFactory, IMemoryCache cache)
    {
        _http = httpFactory.CreateClient();

        _endpoint   = cfg["AZURE_OPENAI_ENDPOINT"]
                      ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT")
                      ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT missing");

        _apiKey     = cfg["AZURE_OPENAI_API_KEY"]
                      ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_API_KEY")
                      ?? throw new InvalidOperationException("AZURE_OPENAI_API_KEY missing");

        _deployment = cfg["AZURE_OPENAI_DEPLOYMENT"]
                      ?? Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT")
                      ?? throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT missing");

        _apiVersion = cfg["AZURE_OPENAI_API_VERSION"] ?? "2024-06-01";

        _cfg = cfg;
        _cache = cache;
    }

    public async Task<string> ToShortTextAsync(ExplainPayload p, CancellationToken ct = default)
    {
        // Cache LLM output per identical payload to save tokens
        var cacheKey = "explain:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(p))));
        if (_cache.TryGetValue(cacheKey, out string cached)) 
            return cached;

        // Load hero blurbs once per process (and refresh occasionally)
        var blurbs = await LoadHeroBlurbsAsync(_cfg, _cache, ct); // id -> blurb
        var nameToId = BuildNameIndex(blurbs);                     // normalized name -> id

        // Resolve team hero identifiers (accepts either ids or names)
        string? NameToId(string nameOrId)
        {
            if (string.IsNullOrWhiteSpace(nameOrId)) return null;

            // Exact id hit
            if (blurbs.ContainsKey(nameOrId)) return nameOrId;

            // Try slug/normalized-name lookup
            var norm = Normalize(nameOrId);
            if (nameToId.TryGetValue(norm, out var idByName)) return idByName;

            // Try simple slug transform
            var slug = Slug(nameOrId);
            if (blurbs.ContainsKey(slug)) return slug;

            return null;
        }

        var teamIds = p.Team
            .Select(NameToId)
            .Where(id => id is not null)
            .Select(id => id!)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        // Build compact, relevant context (<=3 heroes)
        var lines = new List<string>();
        foreach (var id in teamIds.Take(3))
        {
            if (!blurbs.TryGetValue(id, out var b)) continue;

            var bits = new List<string>();
            if (!string.IsNullOrWhiteSpace(b.role))
                bits.Add(b.role);

            // Only include collab partners that are actually on the team
            var partnersOnTeam = b.collabPartners
                .Select(partner => NameToId(partner) ?? Slug(partner))
                .Where(pid => teamIds.Contains(pid))
                .Select(pid => pid!) // pid is id; get display name from blurbs if available
                .Select(pid => blurbs.TryGetValue(pid, out var pb) ? pb.name : pid)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(2)
                .ToList();

            if (partnersOnTeam.Count > 0)
                bits.Add($"team-up with {string.Join("/", partnersOnTeam)}");

            if (bits.Count > 0)
                lines.Add($"{b.name}: {string.Join(", ", bits)}");
        }

        var context = lines.Count > 0 ? $"Context: {string.Join(" | ", lines)}" : null;

        var system = string.IsNullOrEmpty(context)
            ? "Explain in <=80 words why this team works. Cite 2–3 synergies/counters. Be concise."
            : $"Explain in <=80 words why this team works. Cite 2–3 synergies/counters. Be concise. {context}";

        var user = $"TEAM: {string.Join(", ", p.Team)}\n" +
                   $"ENEMY: {string.Join(", ", p.Enemy)}\n" +
                   $"BANS: {string.Join(", ", p.Bans)}\n" +
                   $"SYNERGIES: {string.Join(" | ", p.KeySynergies)}\n" +
                   $"COUNTERS: {string.Join(" | ", p.KeyCounters)}\n" +
                   $"SCORE: {p.Score:F2}";

        var uri = $"{_endpoint.TrimEnd('/')}/openai/deployments/{_deployment}/chat/completions?api-version={_apiVersion}";

        // Small retry for 429 using headers if present
        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, uri);
            req.Headers.Add("api-key", _apiKey);
            req.Content = new StringContent(JsonSerializer.Serialize(new
            {
                messages = new object[]
                {
                    new { role = "system", content = system },
                    new { role = "user",   content = user }
                },
                max_tokens = 250,
                temperature = 0.2
            }), Encoding.UTF8, "application/json");

            using var resp = await _http.SendAsync(req, ct);

            if ((int)resp.StatusCode == 429 && attempt < 2)
            {
                // Respect Retry-After / X-RateLimit-Reset if provided
                var wait = ComputeWaitFromHeaders(resp) ?? TimeSpan.FromMilliseconds(500 * (attempt + 1));
                await Task.Delay(wait, ct);
                continue;
            }

            resp.EnsureSuccessStatusCode();
            var text = await ExtractTextAsync(resp, ct);
            _cache.Set(cacheKey, text, new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromHours(4) });
            return text;
        }

        // Last-chance (shouldn’t reach here due to EnsureSuccessStatusCode)
        return "Explanation unavailable (throttled).";
    }

    // -------- helpers --------

    private static TimeSpan? ComputeWaitFromHeaders(HttpResponseMessage resp)
    {
        if (resp.Headers.TryGetValues("Retry-After", out var ra) &&
            int.TryParse(ra.FirstOrDefault(), out var secs))
            return TimeSpan.FromSeconds(secs);

        if (resp.Headers.TryGetValues("X-RateLimit-Reset", out var reset) &&
            long.TryParse(reset.FirstOrDefault(), out var unix))
        {
            var wait = DateTimeOffset.FromUnixTimeSeconds(unix) - DateTimeOffset.UtcNow;
            if (wait > TimeSpan.Zero) return wait;
        }
        return null;
    }

    private static async Task<string> ExtractTextAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        var json = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement
                  .GetProperty("choices")[0]
                  .GetProperty("message")
                  .GetProperty("content")
                  .GetString()
               ?? "";
    }

    // Load and cache heroes-enriched.json from your storage account
    private static async Task<Dictionary<string, HeroBlurb>> LoadHeroBlurbsAsync(
        IConfiguration cfg, IMemoryCache cache, CancellationToken ct)
    {
        const string cacheKey = "heroes-enriched";
        if (cache.TryGetValue(cacheKey, out Dictionary<string, HeroBlurb> hit) && hit is not null)
            return hit;

        var blobEndpoint = cfg["Data:BlobEndpoint"] ?? cfg["Storage__BlobEndpoint"]
            ?? throw new InvalidOperationException("Blob endpoint missing (Data__BlobEndpoint or Storage__BlobEndpoint).");
        var metaContainer = cfg["Meta__ContainerName"] ?? "meta";
        var version       = cfg["Meta__Version"] ?? "v1";

        var svc  = new BlobServiceClient(new Uri(blobEndpoint), new DefaultAzureCredential());
        var cont = svc.GetBlobContainerClient(metaContainer);

        // Prefer {version}/heroes-enriched.json, but also accept .json.gz transparently
        var primary = cont.GetBlobClient($"{version}/heroes-enriched.json");

        var json = "[]";
        if (await primary.ExistsAsync(ct))
        {
            json = await BlobText.DownloadTextMaybeGzipAsync(cont, primary, ct);
        }
        else
        {
            // Optional: try heroes.json as a fallback
            var fallback = cont.GetBlobClient($"{version}/heroes.json");
            if (await fallback.ExistsAsync(ct))
                json = await BlobText.DownloadTextMaybeGzipAsync(cont, fallback, ct);
        }

        var parsed = JsonSerializer.Deserialize<Dictionary<string, HeroBlurb>>(json)
                     ?? new Dictionary<string, HeroBlurb>(StringComparer.OrdinalIgnoreCase);

        var dict = new Dictionary<string, HeroBlurb>(parsed, StringComparer.OrdinalIgnoreCase);
        cache.Set(cacheKey, dict, new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromHours(6) });
        return dict;
    }

    private static Dictionary<string, string> BuildNameIndex(Dictionary<string, HeroBlurb> byId)
    {
        // normalized hero name => id
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (id, blurb) in byId)
        {
            var n = Normalize(blurb.name);
            dict.TryAdd(n, id);

            // also store slug(name) => id
            var s = Slug(blurb.name);
            dict.TryAdd(s, id);
        }
        return dict;
    }

    private static string Normalize(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        s = s.Trim().ToLowerInvariant();
        s = Regex.Replace(s, @"[^\p{L}\p{Nd}\- ]+", ""); // drop punctuation except hyphen/space
        s = Regex.Replace(s, @"\s+", " ");                // collapse spaces
        return s;
    }

    private static string Slug(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        s = s.Trim().ToLowerInvariant();
        s = Regex.Replace(s, @"[^\p{L}\p{Nd} ]+", "");
        s = Regex.Replace(s, @"\s+", "-");
        return s;
    }
}

public sealed record HeroBlurb(string name, string role, string[] collabPartners, string[] collabLabels);

public sealed record ExplainPayload(
    IReadOnlyList<string> Team,
    IReadOnlyList<string> Enemy,
    IReadOnlyList<string> Bans,
    IReadOnlyList<string> KeySynergies,
    IReadOnlyList<string> KeyCounters,
    double Score);