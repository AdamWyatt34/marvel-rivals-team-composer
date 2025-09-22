using System.Globalization;
using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Blobs;
using CsvHelper;
using CsvHelper.Configuration;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Composer.Functions;

public sealed class BuildCountersFromCsvTimer
{
    private readonly ILogger<BuildCountersFromCsvTimer> _log;
    private readonly IConfiguration _cfg;
    private readonly BlobContainerClient _data;   // data (CSV in clean/)
    private readonly BlobContainerClient _meta;   // meta (outputs)

    public BuildCountersFromCsvTimer(ILogger<BuildCountersFromCsvTimer> log, IConfiguration cfg)
    {
        _log = log; _cfg = cfg;

        var blobEndpoint = _cfg["Data:BlobEndpoint"] ?? throw new InvalidOperationException("Data__BlobEndpoint missing");
        var metaContainer = _cfg["Meta:ContainerName"] ?? "meta";
        var dataContainer = _cfg["Data:ContainerName"] ?? "data";

        var svc = new BlobServiceClient(new Uri(blobEndpoint), new DefaultAzureCredential());
        _data = svc.GetBlobContainerClient(dataContainer);
        _meta = svc.GetBlobContainerClient(metaContainer);
    }

    // Once nightly
    [Function("build-counters-from-csv")]
    public async Task Run([TimerTrigger("0 30 3 * * *")] TimerInfo _, CancellationToken ct)
    {
        var sinceDays = int.TryParse(_cfg["COUNTERS:LookbackDays"], out var d) ? d : 60;
        var version   = _cfg["Meta:Version"] ?? "v1";

        var csvBlobs = await ListCsvFilesAsync(sinceDays, ct);
        if (csvBlobs.Count == 0)
        {
            _log.LogInformation("No CSVs found in lookback");
            return;
        }

        var agg = new Aggregator();

        foreach (var b in csvBlobs)
        {
            await using var s = await b.OpenReadAsync(cancellationToken: ct);
            using var r = new StreamReader(s);
            var csv = new CsvReader(r, new CsvConfiguration(CultureInfo.InvariantCulture)
            {
                HasHeaderRecord = true,
                TrimOptions = TrimOptions.Trim | TrimOptions.InsideQuotes,
                IgnoreBlankLines = true,
                BadDataFound = null,
                MissingFieldFound = null
            });
            
            csv.Read();
            csv.ReadHeader();
            
            while (await csv.ReadAsync())
            {
                try
                {
                    var resultInt  = csv.GetField<int>("result"); // 1 = our team won
                    var our = Split(csv.GetField("our"));
                    var enemy = Split(csv.GetField("enemy"));

                    if (our.Count == 0 || enemy.Count == 0) 
                        continue;

                    var ourWin = resultInt == 1;
                    agg.Add(our, enemy, ourWin);
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Skipping bad row in {Blob}", b.Name);
                }
            }
        }

        var counters = agg.BuildCounters();
        var synergy  = agg.BuildSynergy();

        await _meta.CreateIfNotExistsAsync(cancellationToken: ct);
        await UploadJsonAsync(_meta, $"{version}/counters.json", counters, ct);
        await UploadJsonAsync(_meta, $"{version}/synergy.json", synergy, ct); // optional

        _log.LogInformation("Wrote counters & synergy for {Nheroes} heroes", counters.Count);
    }

    private static List<string> Split(string s)
        => string.IsNullOrWhiteSpace(s) ? [] : s.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    private async Task<List<BlobClient>> ListCsvFilesAsync(int lookbackDays, CancellationToken ct)
    {
        var list = new List<BlobClient>();
        var start = DateTime.UtcNow.Date.AddDays(-lookbackDays);
        // files under clean/YYYY/MM/DD/matches-YYYYMMDD.csv
        await foreach (var item in _data.GetBlobsAsync(prefix: "clean/", cancellationToken: ct))
        {
            if (!item.Name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase)) continue;
            // quick guard: filter by path date blocks
            var parts = item.Name.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 4 && int.TryParse(parts[1], out var y) && int.TryParse(parts[2], out var m) && int.TryParse(parts[3], out var d))
            {
                var dt = new DateTime(y, m, d, 0, 0, 0, DateTimeKind.Utc);
                if (dt < start) continue;
            }
            list.Add(_data.GetBlobClient(item.Name));
        }
        return list;
    }

    private static async Task UploadJsonAsync<T>(BlobContainerClient cont, string name, T obj, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(obj, new JsonSerializerOptions { WriteIndented = false });
        await cont.GetBlobClient(name).UploadAsync(BinaryData.FromString(json), overwrite: true, cancellationToken: ct);
    }

    // ---------------- Aggregator ----------------

    private sealed class Aggregator
    {
        // hero -> wins/total across all enemies (baseline)
        private readonly Dictionary<string, (int wins, int total)> _baseline = new(StringComparer.OrdinalIgnoreCase);

        // our -> enemy -> wins/total
        private readonly Dictionary<string, Dictionary<string, (int wins, int total)>> _pair = new(StringComparer.OrdinalIgnoreCase);

        // team synergy: sorted pair key "a|b" -> wins/total
        private readonly Dictionary<string, (int wins, int total)> _teamPair = new(StringComparer.OrdinalIgnoreCase);

        public void Add(IReadOnlyList<string> our, IReadOnlyList<string> enemy, bool ourWin)
        {
            // baseline per our hero
            foreach (var h in our)
                _baseline[h] = Add(_baseline.GetValueOrDefault(h), ourWin);

            // cross pairs our vs enemy
            foreach (var a in our)
            foreach (var e in enemy)
                UpsertPair(a, e, ourWin);

            // team synergy pairs (same-team)
            AddTeamPairs(our, ourWin);
        }

        private static (int wins, int total) Add((int wins, int total) x, bool win) => (x.wins + (win ? 1 : 0), x.total + 1);

        private void UpsertPair(string a, string e, bool win)
        {
            if (!_pair.TryGetValue(a, out var map))
            {
                map = new(StringComparer.OrdinalIgnoreCase);
                _pair[a] = map;
            }
            map[e] = Add(map.GetValueOrDefault(e), win);
        }

        private void AddTeamPairs(IReadOnlyList<string> team, bool win)
        {
            for (var i = 0; i < team.Count; i++)
            for (var j = i + 1; j < team.Count; j++)
            {
                var a = team[i]; var b = team[j];
                var key = string.Compare(a, b, StringComparison.OrdinalIgnoreCase) < 0 ? $"{a}|{b}" : $"{b}|{a}";
                _teamPair[key] = Add(_teamPair.GetValueOrDefault(key), win);
            }
        }

        public List<CountersRow> BuildCounters(double minWeight = 30, double clampLo = 0.5, double clampHi = 1.5)
        {
            var rows = new List<CountersRow>();
            foreach (var (a, emap) in _pair)
            {
                var baseRt = Rate(_baseline.GetValueOrDefault(a));
                var outMap = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
                foreach (var (e, stats) in emap)
                {
                    if (stats.total < minWeight) continue; // avoid noise
                    var vs = Rate(stats);
                    var mult = baseRt <= 0 ? 1.0 : vs / baseRt;
                    if (double.IsFinite(mult))
                        outMap[e] = Math.Clamp(mult, clampLo, clampHi);
                }
                rows.Add(new CountersRow(a, outMap));
            }
            return rows;
        }

        public List<SynergyRow> BuildSynergy(double minWeight = 30)
        {
            var rows = new List<SynergyRow>();
            foreach (var (key, stats) in _teamPair)
            {
                if (stats.total < minWeight) continue;
                var pairWin = Rate(stats);

                // crude independent baseline: average of each hero baseline
                var parts = key.Split('|');
                var baseA = Rate(_baseline.GetValueOrDefault(parts[0]));
                var baseB = Rate(_baseline.GetValueOrDefault(parts[1]));
                var baseline = (baseA + baseB) / 2.0;

                var uplift = pairWin - baseline; // could also log-odds delta
                rows.Add(new SynergyRow([parts[0], parts[1]], uplift, null));
            }
            // normalize small values around 0 if desired
            return rows;
        }

        private static double Rate((int wins, int total) s) => s.total <= 0 ? 0.0 : (double)s.wins / s.total;

        public sealed record CountersRow(string hero, Dictionary<string, double> counters);
        public sealed record SynergyRow(string[] pair, double score, string? note);
    }
}