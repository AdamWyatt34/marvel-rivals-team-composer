using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Functions.Extensions;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions;

public sealed class ModelExplainFunction
{
    private readonly IConfiguration _cfg;

    public ModelExplainFunction(IConfiguration cfg) => _cfg = cfg;

    public sealed record ExplainRequest(string[] ours, string[] enemy, string? map);

    [Function("model-explain")]
    public async Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req)
    {
        ExplainRequest? input;
        try
        {
            input = await JsonSerializer.DeserializeAsync<ExplainRequest>(req.Body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (input is null) throw new Exception("Payload was null.");
        }
        catch (Exception ex)
        {
            return await req.BadRequestAsync($"Invalid payload: {ex.Message}");
        }

        static string Canon(string s) => (s ?? "").Trim().ToLowerInvariant();
        var ours  = input.ours.Select(Canon).ToArray();
        var enemy = input.enemy.Select(Canon).ToArray();
        var map   = string.IsNullOrWhiteSpace(input.map) ? null : Canon(input.map!);

        // load lr_model.json from blob
        var endpoint = new Uri(_cfg["Models__BlobEndpoint"]!);
        var containerName = _cfg["Models__ContainerName"] ?? "models";
        var blob = new BlobContainerClient(endpoint, new DefaultAzureCredential())
            .GetBlobClient($"{containerName}/latest/lr_model.json");

        if (!await blob.ExistsAsync()) return await req.BadRequestAsync("lr_model.json not found.");

        var json = (await blob.DownloadContentAsync()).Value.Content.ToString();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var bias = root.GetProperty("bias").GetDouble();

        var heroW = new Dictionary<string,double>(StringComparer.Ordinal);
        foreach (var kv in root.GetProperty("hero_features").EnumerateObject())
            heroW[kv.Name] = kv.Value.GetDouble();

        var pairDim = root.GetProperty("pair_hash_dim").GetInt32();
        var pairW = root.GetProperty("pair_weights").EnumerateArray().Select(x => x.GetDouble()).ToArray();

        Dictionary<string,int>? mapIdx = null;
        double[]? mapWeights = null;
        if (root.TryGetProperty("maps", out var mapsEl) && root.TryGetProperty("map_weights", out var mwEl))
        {
            var maps = mapsEl.EnumerateArray().Select(x => x.GetString()!).ToArray();
            mapWeights = mwEl.EnumerateArray().Select(x => x.GetDouble()).ToArray();
            mapIdx = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (var i=0;i<maps.Length;i++) mapIdx[maps[i]] = i;
        }

        var z = bias;
        var parts = new List<object> { new { term = "bias", value = bias } };

        // hero one-hots
        foreach (var h in ours)
        {
            if (heroW.TryGetValue($"our:{h}", out var w)) { z += w; parts.Add(new { term = $"our:{h}", value = w }); }
        }
        foreach (var h in enemy)
        {
            if (heroW.TryGetValue($"enemy:{h}", out var w)) { z += w; parts.Add(new { term = $"enemy:{h}", value = w }); }
        }

        // pairs (ours, enemy, cross) — we’ll list top K contributors for readability
        static IEnumerable<(string a,string b)> Pairs(string[] xs)
        {
            for (var i=0;i<xs.Length;i++)
                for (var j=i+1;j<xs.Length;j++)
                    yield return (xs[i], xs[j]);
        }
        static int HashIdx(string key, int dim)
        {
            var h = SHA256.HashData(Encoding.UTF8.GetBytes(key));
            var idx = BitConverter.ToInt32(h, 0) & int.MaxValue;
            return idx % dim;
        }

        var pairContribs = new List<(string key, double w)>();
        foreach (var (a,b) in Pairs(ours))
        {
            var key = $"pair:our:{a}+{b}";
            var w = pairW[HashIdx(key, pairDim)];
            z += w; pairContribs.Add((key, w));
        }
        foreach (var (a,b) in Pairs(enemy))
        {
            var key = $"pair:enemy:{a}+{b}";
            var w = pairW[HashIdx(key, pairDim)];
            z += w; pairContribs.Add((key, w));
        }
        foreach (var a in ours)
        foreach (var b in enemy)
        {
            var key = $"cross:{a}+{b}";
            var w = pairW[HashIdx(key, pairDim)];
            z += w; pairContribs.Add((key, w));
        }

        var topPairs = pairContribs
            .OrderByDescending(t => Math.Abs(t.w))
            .Take(12)
            .Select(t => new { term = t.key, value = t.w })
            .ToArray();
        parts.AddRange(topPairs);

        // map
        if (map is not null && mapIdx is not null && mapWeights is not null && mapIdx.TryGetValue(map, out var mi))
        {
            var mw = mapWeights[mi];
            z += mw;
            parts.Add(new { term = $"map:{map}", value = mw });
        }

        var p = 1.0 / (1.0 + Math.Exp(-z));
        var resp = new { z, prob = p, breakdown = parts };
        return await req.OkJsonAsync(resp);
    }
}