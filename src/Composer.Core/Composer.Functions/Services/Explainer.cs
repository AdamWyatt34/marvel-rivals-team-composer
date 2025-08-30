using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
    private readonly IMemoryCache _cache;

    public Explainer(IConfiguration cfg, IHttpClientFactory httpFactory, IMemoryCache cache)
    {
        _http       = httpFactory.CreateClient(); // reuse HttpClient from DI
        _endpoint   = cfg["AZURE_OPENAI_ENDPOINT"]
                   ?? throw new InvalidOperationException("AZURE_OPENAI_ENDPOINT missing");
        _apiKey     = cfg["AZURE_OPENAI_API_KEY"]
                   ?? throw new InvalidOperationException("AZURE_OPENAI_API_KEY missing");
        _deployment = cfg["AZURE_OPENAI_DEPLOYMENT"]
                   ?? throw new InvalidOperationException("AZURE_OPENAI_DEPLOYMENT missing");
        _apiVersion = cfg["AZURE_OPENAI_API_VERSION"] ?? "2024-06-01";
        _cache      = cache;
    }

    public async Task<string> ToShortTextAsync(ExplainPayload p, CancellationToken ct = default)
    {
        // Small cache to avoid repeat token usage for identical inputs
        var key = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                     Encoding.UTF8.GetBytes(JsonSerializer.Serialize(p))));
        if (_cache.TryGetValue(key, out string cached)) return cached;

        var system = "Explain in <=80 words why this team works. Cite 2–3 synergies/counters. Be concise.";
        var user   = $"TEAM: {string.Join(", ", p.Team)}\n" +
                     $"ENEMY: {string.Join(", ", p.Enemy)}\n" +
                     $"BANS: {string.Join(", ", p.Bans)}\n" +
                     $"SYNERGIES: {string.Join(" | ", p.KeySynergies)}\n" +
                     $"COUNTERS: {string.Join(" | ", p.KeyCounters)}\n" +
                     $"SCORE: {p.Score:F2}";

        var uri = $"{_endpoint.TrimEnd('/')}/openai/deployments/{_deployment}/chat/completions" +
                  $"?api-version={_apiVersion}";

        using var req = new HttpRequestMessage(HttpMethod.Post, uri);
        req.Headers.Add("api-key", _apiKey);                  // NOTE: Azure OpenAI uses api-key header
        req.Content = new StringContent(JsonSerializer.Serialize(new
        {
            messages = new object[] {
                new { role = "system", content = system },
                new { role = "user",   content = user }
            },
            max_tokens = 250,
            temperature = 0.2
        }), Encoding.UTF8, "application/json");

        using var resp = await _http.SendAsync(req, ct);

        // Handle throttling briefly (simple retry)
        if ((int)resp.StatusCode == 429)
        {
            await Task.Delay(500, ct);
            using var resp2 = await _http.SendAsync(req, ct);
            resp2.EnsureSuccessStatusCode();
            var txt2 = await ExtractTextAsync(resp2, ct);
            _cache.Set(key, txt2, new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromHours(4) });
            return txt2;
        }

        resp.EnsureSuccessStatusCode();
        var text = await ExtractTextAsync(resp, ct);
        _cache.Set(key, text, new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromHours(4) });
        return text;
    }

    private static async Task<string> ExtractTextAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        var json = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement
                  .GetProperty("choices")[0]
                  .GetProperty("message")
                  .GetProperty("content")
                  .GetString() ?? "";
    }
}

// Example payload (match your existing type)
public sealed record ExplainPayload(
    IReadOnlyList<string> Team,
    IReadOnlyList<string> Enemy,
    IReadOnlyList<string> Bans,
    IReadOnlyList<string> KeySynergies,
    IReadOnlyList<string> KeyCounters,
    double Score);
