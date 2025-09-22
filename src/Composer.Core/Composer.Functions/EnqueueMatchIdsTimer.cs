using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Queues;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Composer.Functions;

public sealed class EnqueueMatchIdsTimer
{
    private readonly ILogger<EnqueueMatchIdsTimer> _log;
    private readonly IConfiguration _cfg;
    private readonly IMarvelRivalsApi _api;
    private readonly BlobContainerClient _data;
    private readonly QueueClient _queue;

    public EnqueueMatchIdsTimer(ILogger<EnqueueMatchIdsTimer> log, IConfiguration cfg, IMarvelRivalsApi api)
    {
        _log = log;
        _cfg = cfg;
        _api = api;

        var storage = new BlobServiceClient(new Uri(GetBlobEndpoint(cfg)), new DefaultAzureCredential());
        _data = storage.GetBlobContainerClient(_cfg["Data__ContainerName"] ?? _cfg["Data:ContainerName"] ?? "data");
        _data.CreateIfNotExists();

        // Use the same account as AzureWebJobsStorage for simplicity/cost
        var qEndpoint = _cfg["Queue__Endpoint"] 
                        ?? _cfg["Queue:Endpoint"]
                        ?? Environment.GetEnvironmentVariable("Queue__Endpoint")
                        ?? Environment.GetEnvironmentVariable("Queue:Endpoint")
                        ?? throw new InvalidOperationException("Queue__Endpoint missing");
        var qName = _cfg["Queue__MatchDetailsName"] ?? _cfg["Queue:MatchDetailsName"] ?? "match-details";
        var opts = new QueueClientOptions { MessageEncoding = QueueMessageEncoding.Base64 };
        var qSvc  = new QueueServiceClient(new Uri(qEndpoint), new DefaultAzureCredential(), opts);
        _queue = qSvc.GetQueueClient(qName);
        _queue.CreateIfNotExists();
    }

    [Function("enqueue-match-ids")]
    public async Task Run([TimerTrigger("%ENQUEUE_CRON%")] TimerInfo _, CancellationToken ct)
    {
        var state = await LoadStateAsync(ct);
        if (state.players.Count == 0)
        {
            _log.LogInformation("No players in state"); 
            return;
        }

        var playersPerRun = GetInt("ENQ:PlayersPerRun", 10);
        var maxPages      = GetInt("ENQ:MaxPagesPerPlayer", 6);
        var maxMatches    = GetInt("ENQ:MaxMatchesEnqueued", 2000);
        var interDelayMs  = GetInt("ENQ:InterPageDelayMs", 200);
        var timeBoxSec    = GetInt("ENQ:MaxSecondsPerPlayer", 180);

        var ready = state.players
            .OrderBy(p => p.lastHistoryEpoch)
            .ThenBy(p => p.updateRequestedUtc ?? "")
            .Take(playersPerRun)
            .ToList();

        var enqueued = 0;
        foreach (var p in ready)
        {
            var perDeadline = DateTimeOffset.UtcNow.AddSeconds(timeBoxSec);
            var since = p.lastHistoryEpoch > 0 ? p.lastHistoryEpoch + 1 : 0;
            var page = 1;

            try
            {
                bool more;
                do
                {
                    if (DateTimeOffset.UtcNow >= perDeadline) break;
                    var mh = await _api.GetMatchHistoryAsync(p.id, sinceEpoch: since == 0 ? null : since, page: page, limit: 40, ct: ct);

                    foreach (var m in mh.Items.Where(x => x.game_mode_id == 2 && !string.IsNullOrWhiteSpace(x.match_uid)))
                    {
                        if (enqueued >= maxMatches) break;

                        var msg = new MatchMsg(m.match_uid!, m.match_time_stamp, m.match_map_id);
                        await _queue.SendMessageAsync(JsonSerializer.Serialize(msg), ct);
                        enqueued++;

                        if (m.match_time_stamp > p.lastHistoryEpoch) p.lastHistoryEpoch = m.match_time_stamp;
                    }

                    more = mh.Pagination?.has_more ?? false;
                    page++;
                    await Task.Delay(interDelayMs, ct);
                }
                while (more && page <= maxPages && enqueued < maxMatches);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Enqueue failed for player {Id}", p.id);
            }

            if (enqueued >= maxMatches) break;
        }

        await SaveStateAsync(state, ct);
        _log.LogInformation("Enqueued {N} match IDs from {P} players", enqueued, ready.Count);
    }

    private record MatchMsg(string match_uid, long match_time_stamp, int match_map_id);

    private static string GetBlobEndpoint(IConfiguration cfg)
        => cfg["Data__BlobEndpoint"] ?? cfg["Data:BlobEndpoint"] ?? throw new InvalidOperationException("Data__BlobEndpoint missing (use AzureWebJobsStorage with queues).");

    private int GetInt(string name, int def) => int.TryParse(_cfg[name], out var v) ? v : def;

    // state (same shape you already use)
    private async Task<IngestState> LoadStateAsync(CancellationToken ct)
    {
        var b = _data.GetBlobClient("state/ingest.json");
        if (!await b.ExistsAsync(ct)) return new IngestState();
        var json = (await b.DownloadContentAsync(ct)).Value.Content.ToString();
        return System.Text.Json.JsonSerializer.Deserialize<IngestState>(json) ?? new();
    }

    private Task SaveStateAsync(IngestState s, CancellationToken ct)
        => _data.GetBlobClient("state/ingest.json").UploadAsync(BinaryData.FromString(System.Text.Json.JsonSerializer.Serialize(s)), overwrite: true, cancellationToken: ct);

    private sealed class IngestState { public List<PlayerState> players { get; set; } = []; }
    private sealed class PlayerState
    {
        public string id { get; set; } = "";
        public string? name { get; set; }
        public long lastHistoryEpoch { get; set; }
        public string? updateRequestedUtc { get; set; }
    }
}