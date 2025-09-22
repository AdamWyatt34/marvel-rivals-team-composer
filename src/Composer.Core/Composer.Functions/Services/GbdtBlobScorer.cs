using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Core;
using Composer.Functions.Utilities;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions.Services;

/// <summary>
/// Scores with a small LightGBM ensemble exported to gbdt_model.json.
/// Feature layout matches LR: [our/enemy one-hots][hashed pairs][map one-hot].
/// </summary>
public sealed class GbdtBlobScorer : ITeamScorer
{
    private readonly IConfiguration _cfg;
    private bool _loaded;

    private string[] _heroes = [];
    private Dictionary<string,int> _ourIdx = null!;
    private Dictionary<string,int> _enemyIdx = null!;
    private int _pairDim;
    private string[] _maps = [];
    private Dictionary<string,int>? _mapIdx;

    // priors tail (for fast sum)
    private double[] _heroPrior = [];
    private Dictionary<string,int> _heroPos = null!;

    private double _bias;
    private double _priorScale = 1.0;
    private List<Tree> _trees = [];
    
    private Dictionary<string,double> _enemyImportance = new(StringComparer.OrdinalIgnoreCase);
    public IReadOnlyDictionary<string,double> EnemyImportance => _enemyImportance;
    private Dictionary<string,double>? _priors;
    public bool TryGetHeroPriors(out IReadOnlyDictionary<string,double> priors)
    {
        if (_priors is null || _priors.Count == 0) { priors = null!; return false; }
        priors = _priors;
        return true;
    }

    public GbdtBlobScorer(IConfiguration cfg) => _cfg = cfg;

    private sealed class Tree { public Node[] Nodes = []; public int Root; }
    private sealed class Node
    {
        public int f;        // feature index, -1 for leaf
        public double th;    // threshold
        public int l;        // left child index
        public int r;        // right child index
        public double? leaf; // value if leaf
    }

    private async Task EnsureLoadedAsync(CancellationToken ct)
    {
        if (_loaded) return;

        var endpoint = new Uri(_cfg["Models:BlobEndpoint"] 
                               ?? _cfg["Models__BlobEndpoint"] 
                               ?? Environment.GetEnvironmentVariable("Models__BlobEndpoint") 
                               ?? throw new InvalidOperationException("Models BlobEndpoint missing"));
        var contName = _cfg["Models:ContainerName"] ?? _cfg["Models__ContainerName"] ?? "models";

        var svc  = new BlobServiceClient(endpoint, new DefaultAzureCredential());
        var cont = svc.GetBlobContainerClient(contName);

        // prefer .json, fallback to .json.gz
        var blobJson = cont.GetBlobClient("latest/gbdt_model.json");
        string json;
        if (await blobJson.ExistsAsync(ct))
            json = await BlobText.DownloadTextMaybeGzipAsync(cont, blobJson, ct);
        else
        {
            var blobGz = cont.GetBlobClient("latest/gbdt_model.json.gz");
            if (!await blobGz.ExistsAsync(ct))
                throw new FileNotFoundException("Model not found", "latest/gbdt_model.json(.gz)");
            json = await BlobText.DownloadTextMaybeGzipAsync(cont, blobGz, ct);
        }

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        // --- schema ---
        var schema = root.GetProperty("schema");
        _heroes = schema.GetProperty("heroes").EnumerateArray().Select(e => e.GetString()!).ToArray();
        _pairDim = schema.GetProperty("pair_hash_dim").GetInt32();

        if (schema.TryGetProperty("maps", out var ms) && ms.ValueKind == JsonValueKind.Array)
        {
            _maps = ms.EnumerateArray().Select(x => x.GetString()!).ToArray();
            _mapIdx = _maps.Select((m, i) => (m, i)).ToDictionary(x => x.m, x => x.i, StringComparer.OrdinalIgnoreCase);
        }
        else { _maps = Array.Empty<string>(); _mapIdx = null; }

        // --- enemy importances (optional) ---
        _enemyImportance = new(StringComparer.OrdinalIgnoreCase);
        if (schema.TryGetProperty("importance_enemy", out var imp) && imp.ValueKind == JsonValueKind.Object)
            foreach (var kv in imp.EnumerateObject())
                _enemyImportance[kv.Name] = kv.Value.GetDouble();

        // --- indices for our/enemy one-hots ---
        _ourIdx   = new(StringComparer.OrdinalIgnoreCase);
        _enemyIdx = new(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < _heroes.Length; i++) { _ourIdx[_heroes[i]] = i; _enemyIdx[_heroes[i]] = i + _heroes.Length; }

        // --- priors + prior_scale (optional) ---
        _priors = null;
        if (schema.TryGetProperty("priors", out var pr) && pr.ValueKind == JsonValueKind.Object)
        {
            var dict = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            foreach (var h in _heroes)
                if (pr.TryGetProperty(h, out var v) && v.ValueKind == JsonValueKind.Number)
                    dict[h] = v.GetDouble();
            _priors = dict;
        }

        _priorScale = 1.0;
        if (schema.TryGetProperty("prior_scale", out var ps) && ps.ValueKind == JsonValueKind.Number)
            _priorScale = ps.GetDouble();

        _heroPos = _heroes.Select((h, i) => (h, i)).ToDictionary(x => x.h, x => x.i, StringComparer.OrdinalIgnoreCase);
        _heroPrior = _heroes.Select(h => (_priors != null && _priors.TryGetValue(h, out var v)) ? v : 0.0).ToArray();

        // --- bias (LightGBM average_output) ---
        _bias = (root.TryGetProperty("bias", out var biasEl) && biasEl.ValueKind == JsonValueKind.Number) ? biasEl.GetDouble() : 0.0;

        // --- trees ---
        _trees = new List<Tree>();
        foreach (var t in root.GetProperty("trees").EnumerateArray())
        {
            var arr = t.GetProperty("nodes").EnumerateArray().Select(n => new Node
            {
                f    = n.GetProperty("f").GetInt32(),
                th   = n.GetProperty("th").GetDouble(),
                l    = n.GetProperty("l").GetInt32(),
                r    = n.GetProperty("r").GetInt32(),
                leaf = n.GetProperty("leaf").ValueKind == JsonValueKind.Null ? null : n.GetProperty("leaf").GetDouble()
            }).ToArray();
            _trees.Add(new Tree { Nodes = arr, Root = t.GetProperty("root").GetInt32() });
        }

        _loaded = true;
    }


    public async Task<double> Score(IReadOnlyList<string> ours, IReadOnlyList<string> enemy, string? map = null, CancellationToken ct = default)
    {
        await EnsureLoadedAsync(ct);

        var n1  = _heroes.Length * 2;                   // our+enemy one-hots
        var n2  = _pairDim;                             // hashed pairs
        var n3  = _mapIdx?.Count ?? 0;                  // map one-hot (maybe 0)
        var nTail = 2;                                   // prior_our, prior_enemy
        var dim = n1 + n2 + n3 + nTail;

        var x = dim <= 4096 ? stackalloc float[dim] : new float[dim];

        // one-hots
        foreach (var h in ours)
            if (_ourIdx.TryGetValue(h, out var i1)) x[i1] = 1f;
        foreach (var h in enemy)
            if (_enemyIdx.TryGetValue(h, out var i2)) x[i2] = 1f;

        // pairs
        foreach (var (a, b) in Pairs(ours))  x[n1 + HashIdx($"pair:our:{a}+{b}")]   += 1f;
        foreach (var (a, b) in Pairs(enemy)) x[n1 + HashIdx($"pair:enemy:{a}+{b}")] += 1f;
        foreach (var a in ours)
        foreach (var b in enemy)
            x[n1 + HashIdx($"cross:{a}+{b}")] += 1f;

        // map
        if (!string.IsNullOrWhiteSpace(map) && _mapIdx is not null && _mapIdx.TryGetValue(map, out var mi))
            x[n1 + n2 + mi] = 1f;

        // priors tail
        double priorOur = 0.0, priorEnemy = 0.0;
        foreach (var h in ours)   if (_heroPos.TryGetValue(h, out var pos)) priorOur   += _heroPrior[pos];
        foreach (var h in enemy)  if (_heroPos.TryGetValue(h, out var pos)) priorEnemy += _heroPrior[pos];
        x[n1 + n2 + n3 + 0] = (float)(priorOur   * _priorScale);
        x[n1 + n2 + n3 + 1] = (float)(priorEnemy * _priorScale);

        // raw score = bias + sum(tree(x))
        var z = _bias;
        foreach (var t in _trees) 
            z += Apply(t, x);

        return 1.0 / (1.0 + Math.Exp(-z));
    }

    private static IEnumerable<(string, string)> Pairs(IReadOnlyList<string> xs)
    {
        for (var i = 0; i < xs.Count; i++)
        for (var j = i + 1; j < xs.Count; j++)
            yield return (xs[i], xs[j]);
    }

    private int HashIdx(string key)
    {
        var h = SHA256.HashData(Encoding.UTF8.GetBytes(key));
        var idx = BitConverter.ToInt32(h, 0) & int.MaxValue;
        return idx % _pairDim;
    }

    private static double Apply(Tree t, Span<float> x)
    {
        var idx = t.Root;
        while (true)
        {
            var n = t.Nodes[idx];
            if (n.leaf.HasValue) return n.leaf.Value;
            idx = x[n.f] <= n.th ? n.l : n.r; // LightGBM: go left if <=
        }
    }
}