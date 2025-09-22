using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Core;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions.Services;

/// <summary>
/// Logistic regression scorer backed by lr_model.json in blob storage.
/// Implements ITeamScorer so it can be injected into Composer and BackupsBuilder.
/// </summary>
public sealed class BlobLogRegScorer : ITeamScorer
{
    private readonly IConfiguration _cfg;
    private bool _loaded;
    private double _bias;
    private Dictionary<string, double> _heroW = default!;
    private int _pairDim;
    private double[] _pairW = default!;
    private Dictionary<string, int>? _mapIndex;
    private double[]? _mapW;

    public BlobLogRegScorer(IConfiguration cfg) => _cfg = cfg;

    private async Task EnsureLoadedAsync(CancellationToken ct)
    {
        if (_loaded)
            return;

        var endpoint = new Uri(_cfg["Models__BlobEndpoint"]!);
        var contName = _cfg["Models__ContainerName"] ?? "models";
        var bc = new BlobContainerClient(endpoint, new DefaultAzureCredential())
            .GetBlobClient($"{contName}/latest/lr_model.json");

        var json = (await bc.DownloadContentAsync(ct)).Value.Content.ToString();
        using var doc = JsonDocument.Parse(json);

        _bias = doc.RootElement.GetProperty("bias").GetDouble();

        _heroW = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var kv in doc.RootElement.GetProperty("hero_features").EnumerateObject())
            _heroW[kv.Name] = kv.Value.GetDouble();

        _pairDim = doc.RootElement.GetProperty("pair_hash_dim").GetInt32();
        _pairW = doc.RootElement.GetProperty("pair_weights").EnumerateArray()
            .Select(x => x.GetDouble())
            .ToArray();

        if (doc.RootElement.TryGetProperty("map_weights", out var mw) && mw.ValueKind == JsonValueKind.Array)
        {
            _mapW = mw.EnumerateArray().Select(x => x.GetDouble()).ToArray();
            if (doc.RootElement.TryGetProperty("maps", out var ms) && ms.ValueKind == JsonValueKind.Array)
            {
                _mapIndex = ms.EnumerateArray()
                    .Select((m, i) => new { name = m.GetString()!, i })
                    .ToDictionary(x => x.name, x => x.i, StringComparer.OrdinalIgnoreCase);
            }
        }

        _loaded = true;
    }

    public async Task<double> Score(IReadOnlyList<string> ours, IReadOnlyList<string> enemy, string? map = null, CancellationToken ct = default)
    {
        await EnsureLoadedAsync(ct);
        var z = _bias;

        // hero one-hots
        foreach (var h in ours)
            if (_heroW.TryGetValue($"our:{h}", out var w1))
                z += w1;
        foreach (var h in enemy)
            if (_heroW.TryGetValue($"enemy:{h}", out var w2))
                z += w2;

        // hashed pair features
        foreach (var (a, b) in Pairs(ours)) z += HashW($"pair:our:{a}+{b}");
        foreach (var (a, b) in Pairs(enemy)) z += HashW($"pair:enemy:{a}+{b}");
        foreach (var a in ours)
        foreach (var b in enemy)
            z += HashW($"cross:{a}+{b}");

        // map (optional)
        if (!string.IsNullOrWhiteSpace(map) && _mapIndex is not null && _mapW is not null && _mapIndex.TryGetValue(map, out var mi))
            z += _mapW[mi];

        return 1.0 / (1.0 + Math.Exp(-z)); // sigmoid
    }

    public IReadOnlyDictionary<string, double> EnemyImportance { get; } = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
    public bool TryGetHeroPriors(out IReadOnlyDictionary<string, double> priors)
    {
        priors = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        return false;
    }

    private double HashW(string key)
    {
        var bytes = Encoding.UTF8.GetBytes(key);
        var h = SHA256.HashData(bytes);
        var idx = BitConverter.ToInt32(h, 0) & int.MaxValue;
        return _pairW[idx % _pairDim];
    }

    private static IEnumerable<(string, string)> Pairs(IReadOnlyList<string> xs)
    {
        for (var i = 0; i < xs.Count; i++)
        for (var j = i + 1; j < xs.Count; j++)
            yield return (xs[i], xs[j]);
    }
}
