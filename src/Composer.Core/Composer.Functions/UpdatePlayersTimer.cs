using System.Text.Json;
using Azure.Identity;
using Azure.Storage.Blobs;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace Composer.Functions;

public sealed class UpdatePlayersTimer
{
    private readonly IConfiguration _cfg;
    private readonly ILogger<UpdatePlayersTimer> _log;
    private readonly IMarvelRivalsApi _api;
    private readonly BlobContainerClient _cont;

    public UpdatePlayersTimer(IConfiguration cfg, ILogger<UpdatePlayersTimer> log, IMarvelRivalsApi api)
    {
        _cfg = cfg;
        _log = log;
        _api = api;
        var svc = new BlobServiceClient(new Uri(_cfg["Data__BlobEndpoint"] ?? _cfg["Data:BlobEndpoint"]!), new DefaultAzureCredential());
        _cont  = svc.GetBlobContainerClient(_cfg["Data__ContainerName"] ?? "data");
    }

    [Function("update-players")]
    public async Task Run([TimerTrigger("%UPDATE_CRON%")] TimerInfo timer, CancellationToken ct)
{
    await _cont.CreateIfNotExistsAsync(cancellationToken: ct);

    var state = await LoadStateAsync(ct);
    // NEW: merge new seeds each run
    // var added = await MergeSeedsAsync(state, ct);
    // if (added > 0) _log.LogInformation("Merged {Count} new players from seed", added);

    var maxUpdates = int.TryParse(_cfg["INGEST__MaxUpdatesPerRun"], out var mu) ? mu : 5;

    var now = DateTimeOffset.UtcNow;
    var issued = 0;
    foreach (var p in state.players.OrderBy(x => x.updateRequestedUtc ?? "").Take(maxUpdates))
    {
        try
        {
            await _api.RequestPlayerUpdateAsync(p.id, ct);
            p.updateRequestedUtc = now.ToString("O");
            issued++;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Update call failed for {Id}", p.id);
        }
    }

    await SaveStateAsync(state, ct);
    _log.LogInformation("Issued {Count} player updates", issued);
}

private static bool IsUid(string? s) => !string.IsNullOrWhiteSpace(s) && s.All(char.IsDigit);

private async Task<int> MergeSeedsAsync(IngestState state, CancellationToken ct)
{
    var seed = _cont.GetBlobClient("state/seed_players.txt");
    if (!await seed.ExistsAsync(ct))
        return 0;

    var txt   = (await seed.DownloadContentAsync(ct)).Value.Content.ToString();
    var lines = txt.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    // Only index true UIDs here (avoid name-only ids polluting the check)
    var byUid = state.players
        .Where(p => IsUid(p.id))
        .ToDictionary(p => p.id, StringComparer.OrdinalIgnoreCase);

    var added = 0;

    foreach (var qraw in lines)
    {
        var q = qraw.Trim();
        if (q.Length == 0) continue;

        var qIsUid = IsUid(q);

        // If seed is a UID and we already track that UID, skip
        if (qIsUid && byUid.ContainsKey(q)) 
            continue;

        // If seed is a NAME and we already have that name with a known UID, skip
        if (!qIsUid && state.players.Any(p =>
                string.Equals(p.name, q, StringComparison.OrdinalIgnoreCase) && IsUid(p.id)))
            continue;

        try
        {
            // Resolve either UID or name
            var resolved = await _api.ResolvePlayerAsync(q, ct);
            if (resolved is not null)
            {
                var uid  = resolved.PlayerUid ?? q;       // prefer UID if API returns it
                var name = resolved.NickName  ?? q;

                if (IsUid(uid))
                {
                    // Add by UID if not present
                    if (!byUid.ContainsKey(uid))
                    {
                        var p = new PlayerState { id = uid, name = name };
                        state.players.Add(p);
                        byUid[uid] = p;
                        added++;
                    }
                }
                else
                {
                    // API didn’t give a UID (rare) – add/merge by name as placeholder
                    var existingByName = state.players.FirstOrDefault(p =>
                        string.Equals(p.name, name, StringComparison.OrdinalIgnoreCase));
                    if (existingByName is null)
                    {
                        state.players.Add(new PlayerState { id = name, name = name });
                        added++;
                    }
                    // else keep existing; upgrade will happen in the pass below
                }
            }
            else
            {
                _log.LogWarning("Seed '{q}' could not be resolved (null)", q);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to resolve seed '{q}'", q);
        }
    }

    // Optional: upgrade name-only entries to UID when resolvable
    foreach (var p in state.players.ToList())
    {
        if (IsUid(p.id)) continue; // already a UID
        try
        {
            var resolved = await _api.ResolvePlayerAsync(p.id, ct); // p.id might be a name
            if (IsUid(resolved?.PlayerUid) && !byUid.ContainsKey(resolved!.PlayerUid))
            {
                byUid.Remove(p.id); // harmless if not present
                p.id = resolved.PlayerUid!;
                if (string.IsNullOrWhiteSpace(p.name)) p.name = resolved.NickName ?? p.id;
                byUid[p.id] = p;
            }
        }
        catch { /* non-fatal */ }
    }

    return added;
}

private async Task<IngestState> LoadStateAsync(CancellationToken ct)
{
    var blob = _cont.GetBlobClient("state/ingest.json");
    if (await blob.ExistsAsync(ct))
    {
        var json = (await blob.DownloadContentAsync(ct)).Value.Content.ToString();
        return JsonSerializer.Deserialize<IngestState>(json) ?? new();
    }
    return new IngestState();
}


    private Task SaveStateAsync(IngestState s, CancellationToken ct)
        => _cont.GetBlobClient("state/ingest.json")
                .UploadAsync(BinaryData.FromString(JsonSerializer.Serialize(s)), overwrite:true, cancellationToken: ct);

    private sealed class IngestState { public List<PlayerState> players { get; set; } = []; }
    private sealed class PlayerState
    {
        public string id { get; set; } = "";
        public string? name { get; set; }
        public long lastHistoryEpoch { get; set; }
        public string? updateRequestedUtc { get; set; }
    }
}