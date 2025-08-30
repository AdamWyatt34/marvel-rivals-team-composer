using System.Net;
using System.Text.Json;
using Composer.Core;
using Composer.Core.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Composer.Functions;

public sealed class HeroDetailsFunction
{
    private readonly Roster _roster;
    public HeroDetailsFunction(IRosterProvider rosterProvider) => _roster = rosterProvider.GetAsync().GetAwaiter().GetResult();

    public sealed record HeroDetails(
        string id, string name, string role,
        string[] topCounters,    // enemies this hero is strong into
        string[] topThreats,     // enemies that counter this hero (reverse lookup)
        string[] topSynergies    // teammates with highest pair score
    );

    [Function("hero")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "hero/{id}")] HttpRequestData req,
        string id)
    {
        id = (id ?? "").Trim().ToLowerInvariant();
        if (!_roster.Heroes.TryGetValue(id, out var hero))
        {
            var nf = req.CreateResponse(HttpStatusCode.NotFound);
            await nf.WriteStringAsync($"Unknown hero id '{id}'");
            return nf;
        }

        // Top counters this hero has vs others (by multiplier)
        var topCounters = _roster.Counters.TryGetValue(id, out var cmap)
            ? cmap.OrderByDescending(kv => kv.Value).Take(5).Select(kv => kv.Key).ToArray()
            : Array.Empty<string>();

        // Top threats (who counters THIS hero): reverse over all C maps
        var topThreats = _roster.Counters
            .Select(kv => new { enemy = kv.Key, mult = kv.Value.TryGetValue(id, out var v) ? v : 1.0 })
            .OrderByDescending(x => x.mult).Take(5).Select(x => x.enemy).ToArray();

        // Top pair synergies
        var topSynergies = _roster.Synergy
            .Where(kv => kv.Key.Item1 == id || kv.Key.Item2 == id)
            .OrderByDescending(kv => kv.Value)
            .Take(5)
            .Select(kv => kv.Key.Item1 == id ? kv.Key.Item2 : kv.Key.Item1)
            .ToArray();

        string Name(string hid) => _roster.Heroes.TryGetValue(hid, out var h) ? h.Name : hid;

        var payload = new HeroDetails(
            id, hero.Name, hero.PrimaryRole.ToString(),
            topCounters.Select(Name).ToArray(),
            topThreats.Select(Name).ToArray(),
            topSynergies.Select(Name).ToArray()
        );

        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(payload));
        return res;
    }
}