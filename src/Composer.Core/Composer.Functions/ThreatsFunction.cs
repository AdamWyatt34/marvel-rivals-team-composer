using System.Net;
using System.Text.Json;
using Composer.Core;
using Composer.Core.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Composer.Functions;

public sealed class ThreatsFunction
{
    private readonly Roster _roster;
    public ThreatsFunction(IRosterProvider rosterProvider) => _roster = rosterProvider.GetAsync().GetAwaiter().GetResult();

    public sealed record ThreatEntry(string id, string name, double mult);
    // Response shape: { "<heroId>": { mult: 1.35, by: { id: "psylocke", name: "Psylocke", mult: 1.35 } } }
    public sealed record ThreatResult(double mult, ThreatEntry? by);

    [Function("threats")]
    public async Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Anonymous, "get")] HttpRequestData req)
    {
        var query = System.Web.HttpUtility.ParseQueryString(new Uri(req.Url.ToString()).Query);
        var enemyCsv = (query["enemy"] ?? "").Trim();
        var enemyIds = enemyCsv.Length == 0
            ? Array.Empty<string>()
            : enemyCsv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                      .Select(s => s.ToLowerInvariant()).ToArray();

        // Pre-validate list
        var enemies = enemyIds.Where(id => _roster.Heroes.ContainsKey(id)).ToArray();

        var result = new Dictionary<string, ThreatResult>(StringComparer.OrdinalIgnoreCase);

        foreach (var h in _roster.Heroes.Values)
        {
            double maxMult = 1.0;
            string? maxEnemyId = null;

            foreach (var e in enemies)
            {
                // "Enemy counters me": look up C[enemy][me]
                if (_roster.Counters.TryGetValue(e, out var cmap) && cmap.TryGetValue(h.Id, out var multAgainstH))
                {
                    if (multAgainstH > maxMult)
                    {
                        maxMult = multAgainstH;
                        maxEnemyId = e;
                    }
                }
            }

            ThreatEntry? by = null;
            if (maxEnemyId is not null && _roster.Heroes.TryGetValue(maxEnemyId, out var enemyHero))
            {
                by = new ThreatEntry(maxEnemyId, enemyHero.Name, maxMult);
            }

            result[h.Id] = new ThreatResult(mult: maxMult, by: by);
        }

        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(result));
        return res;
    }
}