using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions.Services;

public interface IExplainer
{
    Task<string> ToShortTextAsync(ExplainPayload payload, CancellationToken ct = default);
}

public sealed record ExplainPayload(
    IReadOnlyList<string> Team,
    IReadOnlyList<string> Enemy,
    IReadOnlyList<string> Bans,
    IReadOnlyList<string> KeySynergies,
    IReadOnlyList<string> KeyCounters,
    double Score
);

public sealed class Explainer : IExplainer
{
    private readonly HttpClient _http;
    private readonly string? _endpoint;
    private readonly string? _apiKey;
    private readonly string _model;
    private readonly IMemoryCache _cache;

    public Explainer(IConfiguration cfg, IHttpClientFactory f, IMemoryCache cache)
    {
        _http = f.CreateClient();
        _endpoint = cfg["AI__Endpoint"] ?? cfg["AI:Endpoint"];
        _apiKey   = cfg["AI__ApiKey"]   ?? cfg["AI:ApiKey"];
        _model    = cfg["AI__Model"]    ?? cfg["AI:Model"] ?? "Phi-3.5-mini-instruct";
        _cache = cache;
    }

    public async Task<string> ToShortTextAsync(ExplainPayload p, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(_endpoint) || string.IsNullOrWhiteSpace(_apiKey))
            return "LLM off (set AI__Endpoint and AI__ApiKey to enable).";

        var key = Hash(p);
        if (_cache.TryGetValue(key, out string? cached) && cached is not null) return cached;

        var system = "Explain in <=80 words why this team works. Cite 2–3 synergies/counters. Be concise.";
        var user = $"TEAM: {string.Join(", ", p.Team)}\nENEMY: {string.Join(", ", p.Enemy)}\nBANS: {string.Join(", ", p.Bans)}\nSYNERGIES: {string.Join(" | ", p.KeySynergies)}\nCOUNTERS: {string.Join(" | ", p.KeyCounters)}\nSCORE: {p.Score:F2}";

        using var req = new HttpRequestMessage(HttpMethod.Post, $"{_endpoint}/chat/completions");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        req.Content = new StringContent(JsonSerializer.Serialize(new {
            model = _model,
            messages = new object[] { new { role = "system", content = system }, new { role = "user", content = user } },
            max_tokens = 250, temperature = 0.2
        }), Encoding.UTF8, "application/json");

        using var resp = await _http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();
        var json = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);
        var text = doc.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "";
        _cache.Set(key, text, new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromHours(4) });
        return text;
    }

    private static string Hash(ExplainPayload p)
    {
        var raw = JsonSerializer.Serialize(p);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
    }
}