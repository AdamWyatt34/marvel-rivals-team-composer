using System.Text;
using System.Text.Json;
using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Specialized;
using Azure.Storage.Queues.Models;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;

namespace Composer.Functions;

public sealed class FetchMatchDetailsQueue
{
    private readonly IConfiguration _cfg;
    private readonly IMarvelRivalsApi _api;
    private readonly IHeroSlugMapper _map;
    private readonly BlobContainerClient _data;
    
    private const string CsvHeader = "match_id,timestamp,map,patch,result,our,enemy,our_bans,enemy_bans";

    public FetchMatchDetailsQueue(IConfiguration cfg, IMarvelRivalsApi api, IHeroSlugMapper map)
    {
        _cfg = cfg;
        _api = api;
        _map = map;
        var storage = new BlobServiceClient(new Uri(GetBlobEndpoint(cfg)), new DefaultAzureCredential());
        _data = storage.GetBlobContainerClient(_cfg["Data__ContainerName"] ?? "data");
        _data.CreateIfNotExists();
    }

    [Function("fetch-match-details")]
    public async Task Run(
        [QueueTrigger("%Queue:MatchDetailsName%", Connection = "Queue:ConnString")] QueueMessage message,
        CancellationToken ct)
    {
        var payload = JsonSerializer.Deserialize<MatchMsg>(message.Body.ToString())
            ?? throw new InvalidOperationException("Invalid message payload.");
        var matchId = payload.match_uid;

        // Idempotency marker: skip if processed
        var mark = _data.GetBlobClient($"marks/processed/{matchId}");
        if (await mark.ExistsAsync(ct)) return;

        var det = await _api.GetMatchDetailsAsync(matchId, ct);
        if (det is null || det.game_mode.game_mode_id != 2) return;

        // Build one CSV line (schema matches your trainer)
        var (our, enemy) = SplitTeams(det);
        var (ourBans, enemyBans) = ExtractBans(det);

        var isoTs = DateTimeOffset.FromUnixTimeSeconds(payload.match_time_stamp).UtcDateTime.ToString("O");
        var mapName = MapNameFromId(payload.match_map_id);

        var line = BuildCsvLine(new CsvRow
        {
            match_id = det.match_uid,
            timestamp = isoTs,
            map = mapName,
            patch = null,
            result = MajorityWin(det) ?? false,
            our = our,
            enemy = enemy,
            our_bans = ourBans,
            enemy_bans = enemyBans
        });

        // Append-blob for the day (cheap single artifact per day)
        var y = DateTime.UtcNow;
        var csvName = $"clean/{y:yyyy/MM/dd}/matches-{y:yyyyMMdd}.csv";
        await EnsureAppendBlobAsync(_data, csvName, ct);
        await AppendLineAsync(_data, csvName, line, ct);

        // Create marker last to ensure idempotency
        await mark.UploadAsync(BinaryData.FromString(""), overwrite: false, cancellationToken: ct);
    }

    // -------------- Helpers --------------

    private static string GetBlobEndpoint(IConfiguration cfg)
        => cfg["Data__BlobEndpoint"] ?? cfg["Data:BlobEndpoint"] ?? throw new InvalidOperationException("Data__BlobEndpoint missing.");

    private static readonly IReadOnlyDictionary<int, string> CompetitiveMaps = new Dictionary<int, string>
    {
        [1217] = "Central Park",
        [1230] = "Shin-Shibuya",
        [1231] = "Yggdrasill Path",
        [1236] = "Royal Palace",
        [1245] = "Spider-Islands",
        [1267] = "Hall of Djalia",
        [1272] = "Birnin T'Challa",
        [1273] = "Grove",
        [1281] = "Carousel",
        [1286] = "Arakko",
        [1288] = "Hell's Heaven",
        [1290] = "Symbiotic Surface",
        [1291] = "Midtown",
        [1310] = "Krakoa",
        [1311] = "Arakko",
        [1318] = "Celestial Husk",
    };

    private static string? MapNameFromId(int id) =>
        CompetitiveMaps.GetValueOrDefault(id);

    private static bool? MajorityWin(MatchDetails det)
    {
        var c0 = det.match_players.Where(p => p.camp == 0).Count(p => p.is_win == 1);
        var c1 = det.match_players.Where(p => p.camp == 1).Count(p => p.is_win == 1);
        if (c0 + c1 == 0) return null;
        return c0 >= c1;
    }

    private (string[] our, string[] enemy) SplitTeams(MatchDetails det)
    {
        var our = new List<string>();
        var them = new List<string>();
        foreach (var g in det.match_players.GroupBy(p => p.camp))
        {
            var team = new List<string>();
            foreach (var p in g)
            {
                // Choose the hero with max play_time for that player
                var best = p.player_heroes?.OrderByDescending(h => h.play_time).FirstOrDefault();
                var slug = _map.FromIconPath(best?.hero_icon) ?? _map.FromNumericId(best?.hero_id ?? p.cur_hero_id);
                if (slug is not null) team.Add(slug);
            }
            team = team.Take(6).ToList();
            if (g.Key == 0) our = team; else them = team;
        }
        return (our.ToArray(), them.ToArray());
    }

    private (string[] ourBans, string[] enemyBans) ExtractBans(MatchDetails det)
    {
        var ours = new List<string>();
        var them = new List<string>();
        foreach (var b in det.dynamic_fields?.ban_pick_info ?? [])
        {
            if (b is { vote_type: 1, is_pick: 0 })
            {
                var slug = _map.FromNumericId(b.hero_id);
                if (slug is not null)
                    (b.battle_side == 0 ? ours : them).Add(slug);
            }
        }
        return (ours.Distinct().Take(6).ToArray(), them.Distinct().Take(6).ToArray());
    }

    private static string BuildCsvLine(CsvRow r)
    {
        string Q(string s) => "\"" + (s ?? "").Replace("\"","\"\"") + "\"";
        return string.Join(",", new[]
        {
            Q(r.match_id),
            Q(r.timestamp),
            Q(r.map ?? ""),
            Q(r.patch ?? ""),
            r.result ? "1" : "0",
            Q(string.Join("|", r.our)),
            Q(string.Join("|", r.enemy)),
            Q(string.Join("|", r.our_bans)),
            Q(string.Join("|", r.enemy_bans))
        });
    }

    private static AppendBlobClient GetAppend(BlobContainerClient container, string blobName)
        => container.GetAppendBlobClient(blobName);

    private static async Task EnsureAppendBlobAsync(BlobContainerClient container, string blobName, CancellationToken ct)
    {
        var append = container.GetAppendBlobClient(blobName);
        var exists = await append.ExistsAsync(ct);
        if (!exists.Value)
        {
            await append.CreateAsync(cancellationToken: ct);

            // write header line once
            var headerBytes = Encoding.UTF8.GetBytes(CsvHeader + Environment.NewLine);
            using var hs = new MemoryStream(headerBytes, writable: false);
            await append.AppendBlockAsync(hs, cancellationToken: ct);
        }
    }

    private static async Task AppendLineAsync(
        BlobContainerClient container,
        string blobName,
        string line,
        CancellationToken ct)
    {
        var append = container.GetAppendBlobClient(blobName);

        // convert the string to bytes
        var bytes = Encoding.UTF8.GetBytes(line + Environment.NewLine);
        using var ms = new MemoryStream(bytes, writable: false);

        await append.AppendBlockAsync(ms, cancellationToken: ct);
    }


    private sealed record MatchMsg(string match_uid, long match_time_stamp, int match_map_id);

    private sealed record CsvRow
    {
        public string match_id { get; init; } = "";
        public string timestamp { get; init; } = "";
        public string? map { get; init; }
        public string? patch { get; init; }
        public bool result { get; init; }
        public string[] our { get; init; } = [];
        public string[] enemy { get; init; } = [];
        public string[] our_bans { get; init; } = [];
        public string[] enemy_bans { get; init; } = [];
    }
}