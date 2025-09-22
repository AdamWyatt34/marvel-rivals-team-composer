using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Functions.Extensions;
using Composer.Functions.Utilities;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions;

public sealed class ModelExplainGbdtFunction
{
    private readonly IConfiguration _cfg;
    public ModelExplainGbdtFunction(IConfiguration cfg) => _cfg = cfg;

    public sealed record ExplainRequest(string[] ours, string[] enemy, string? map);

    [Function("model-explain-gbdt")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req,
        FunctionContext ctx)
    {
        ExplainRequest? input;
        try
        {
            input = await JsonSerializer.DeserializeAsync<ExplainRequest>(
                req.Body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (input is null) throw new Exception("Payload was null.");
        }
        catch (Exception ex)
        {
            return await req.BadRequestAsync($"Invalid payload: {ex.Message}");
        }

        static string Canon(string s) => (s ?? "").Trim().ToLowerInvariant();
        var ours  = (input.ours  ?? []).Select(Canon).ToArray();
        var enemy = (input.enemy ?? []).Select(Canon).ToArray();
        var map   = string.IsNullOrWhiteSpace(input.map) ? null : Canon(input.map!);

        // ---- Load compact model JSON from Blob ----
        var endpoint  = new Uri(_cfg["Models:BlobEndpoint"] ?? _cfg["Models__BlobEndpoint"]!);
        var contName  = _cfg["Models:ContainerName"] ?? _cfg["Models__ContainerName"] ?? "models";
        var svc       = new BlobServiceClient(endpoint, new DefaultAzureCredential());
        var cont      = svc.GetBlobContainerClient(contName);

        string json;
        var blobJson = cont.GetBlobClient("latest/gbdt_model.json");
        if (await blobJson.ExistsAsync())
            json = await BlobText.DownloadTextMaybeGzipAsync(cont, blobJson, CancellationToken.None);
        else
        {
            var blobGz = cont.GetBlobClient("latest/gbdt_model.json.gz");
            if (!await blobGz.ExistsAsync())
                return await req.BadRequestAsync("Model not found at latest/gbdt_model.json(.gz).");
            json = await BlobText.DownloadTextMaybeGzipAsync(cont, blobGz, CancellationToken.None);
        }

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        // ---- Read compact schema ----
        var schema = root.GetProperty("schema");
        var heroes = schema.GetProperty("heroes").EnumerateArray().Select(e => e.GetString()!).ToArray();
        var H = heroes.Length;
        var pairDim = schema.GetProperty("pair_hash_dim").GetInt32();
        var maps = schema.TryGetProperty("maps", out var ms) && ms.ValueKind == JsonValueKind.Array
            ? ms.EnumerateArray().Select(x => x.GetString()!).ToArray()
            : [];
        // tail features are fixed: ["prior_our_scaled", "prior_enemy_scaled"]
        const int Tail = 2;

        // ---- Build feature name list & index ----
        // Must mirror training order:
        // our:<hero> (H), enemy:<hero> (H), hash:<i> (pairDim), map:<name> (maps.Length), priors (2)
        var featureNames = new List<string>(2*H + pairDim + maps.Length + Tail);
        featureNames.AddRange(heroes.Select(h => $"our:{h}"));
        featureNames.AddRange(heroes.Select(h => $"enemy:{h}"));
        featureNames.AddRange(Enumerable.Range(0, pairDim).Select(i => $"hash:{i}"));
        featureNames.AddRange(maps.Select(m => $"map:{m}"));
        featureNames.Add("prior_our_scaled");
        featureNames.Add("prior_enemy_scaled");

        var fIndex = new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < featureNames.Count; i++) fIndex[featureNames[i]] = i;

        // ---- Build X ----
        var x = new double[featureNames.Count];

        foreach (var h in ours)
            if (fIndex.TryGetValue($"our:{h}", out var idx)) x[idx] = 1.0;

        foreach (var h in enemy)
            if (fIndex.TryGetValue($"enemy:{h}", out var idx)) x[idx] = 1.0;

        // hashed pairs/cross (same as training: SHA256 -> Int32 -> mod pairDim)
        static int HashIdx(string key, int dim)
        {
            var h = SHA256.HashData(Encoding.UTF8.GetBytes(key));
            var v = BitConverter.ToInt32(h, 0) & int.MaxValue;
            return v % dim;
        }
        static IEnumerable<(string,string)> Pairs(IReadOnlyList<string> ids)
        {
            for (var i = 0; i < ids.Count; i++)
                for (var j = i + 1; j < ids.Count; j++)
                    yield return (ids[i], ids[j]);
        }

        var hashBase = 2*H; // start of hash block
        foreach (var (a,b) in Pairs(ours))
            x[hashBase + HashIdx($"pair:our:{a}+{b}", pairDim)] += 1.0;
        foreach (var (a,b) in Pairs(enemy))
            x[hashBase + HashIdx($"pair:enemy:{a}+{b}", pairDim)] += 1.0;
        foreach (var a in ours)
            foreach (var b in enemy)
                x[hashBase + HashIdx($"cross:{a}+{b}", pairDim)] += 1.0;

        // map one-hot
        if (map is not null && maps.Length > 0)
        {
            var mapBase = 2*H + pairDim;
            var mi = Array.FindIndex(maps, m => string.Equals(m, map, StringComparison.OrdinalIgnoreCase));
            if (mi >= 0) x[mapBase + mi] = 1.0;
        }

        // priors tail (we don’t recompute per-hero priors here; the scorer uses raw trees only)
        // You can optionally inject the same row-level priors if you want parity with training;
        // for now, leave them 0 to attribute only structural features.

        // ---- Score & attribute by traversing compact trees ----
        var raw = 0.0;
        var contrib = new Dictionary<int,(double sum,int count)>(); // featureIndex -> credit

        foreach (var t in root.GetProperty("trees").EnumerateArray())
        {
            var (leafVal, usedFeatures) = FollowTreeCompact(t.GetProperty("nodes"), t.GetProperty("root").GetInt32(), x);
            raw += leafVal;
            if (usedFeatures.Count == 0) continue;
            var credit = leafVal / usedFeatures.Count;
            foreach (var fi in usedFeatures)
            {
                if (!contrib.TryGetValue(fi, out var agg)) agg = (0,0);
                agg.sum += credit; agg.count += 1;
                contrib[fi] = agg;
            }
        }

        var prob = 1.0 / (1.0 + Math.Exp(-raw));

        var items = contrib
            .Select(kv => new {
                index = kv.Key,
                name = kv.Key >= 0 && kv.Key < featureNames.Count ? featureNames[kv.Key] : $"f{kv.Key}",
                contrib = kv.Value.sum,
                visits = kv.Value.count
            })
            .OrderByDescending(i => Math.Abs(i.contrib))
            .ToArray();

        var resp = new {
            prob,
            raw,
            topPositive = items.Where(i => i.contrib > 0).Take(12).ToArray(),
            topNegative = items.Where(i => i.contrib < 0).Take(12).ToArray(),
            // optional: include a small tail for UI
            attributions = items.Take(100).ToArray()
        };

        return await req.OkJsonAsync(resp);
    }

    // Walk our compact tree format: nodes[f,th,l,r,leaf], root index given.
    private static (double leafValue, HashSet<int> usedFeatures) FollowTreeCompact(JsonElement nodesEl, int rootIdx, double[] x)
    {
        var idx = rootIdx;
        var used = new HashSet<int>();
        while (true)
        {
            var n = nodesEl[idx];
            if (n.TryGetProperty("leaf", out var leafEl) && leafEl.ValueKind != JsonValueKind.Null)
                return (leafEl.GetDouble(), used);

            var f = n.GetProperty("f").GetInt32();
            var th = n.GetProperty("th").GetDouble();
            var l = n.GetProperty("l").GetInt32();
            var r = n.GetProperty("r").GetInt32();

            var v = f >= 0 && f < x.Length ? x[f] : 0.0;
            var goLeft = v <= th;
            used.Add(f);
            idx = goLeft ? l : r;
        }
    }
}