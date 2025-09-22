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
    public ThreatsFunction(IRosterProvider rosterProvider)
        => _roster = rosterProvider.GetAsync().GetAwaiter().GetResult();

    public sealed record ThreatEntry(string id, string name, double mult);
    public sealed record ThreatResult(double mult, ThreatEntry? by);

    [Function("threats")]
    public async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get")] HttpRequestData req)
    {
        var query = System.Web.HttpUtility.ParseQueryString(new Uri(req.Url.ToString()).Query);
        var enemyCsv = (query["enemy"] ?? "").Trim();
        var enemyIds = enemyCsv.Length == 0
            ? []
            : enemyCsv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                      .Select(s => s.ToLowerInvariant())
                      .Where(id => _roster.Heroes.ContainsKey(id))   // validate ids
                      .ToArray();

        var result = new Dictionary<string, ThreatResult>(StringComparer.OrdinalIgnoreCase);

        foreach (var me in _roster.Heroes.Values)
        {
            var maxThreat = 1.0;
            string? worstEnemyId = null;

            // counters.json: counters[ourHero][enemyHero] = vs / baseline (clamped ~[0.5,1.5])
            // Threat should be >1 when enemy hurts us => 1 / counters[me][enemy]
            if (_roster.Counters.TryGetValue(me.Id, out var vsMap))
            {
                foreach (var e in enemyIds)
                {
                    if (!vsMap.TryGetValue(e, out var multVsEnemy) || multVsEnemy <= 0)
                        continue;

                    var threat = 1.0 / multVsEnemy;  // invert: <1 favorable -> threat<1; <1.0 -> good, >1.0 -> bad
                    if (threat > maxThreat)
                    {
                        maxThreat = threat;
                        worstEnemyId = e;
                    }
                }
            }

            ThreatEntry? by = null;
            if (worstEnemyId is not null && _roster.Heroes.TryGetValue(worstEnemyId, out var enemyHero))
                by = new ThreatEntry(worstEnemyId, enemyHero.Name, maxThreat);

            result[me.Id] = new ThreatResult(mult: maxThreat, by: by);
        }

        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json");
        // (Optional) res.Headers.Add("Cache-Control", "no-store");
        await res.WriteStringAsync(JsonSerializer.Serialize(result));
        return res;
    }
}