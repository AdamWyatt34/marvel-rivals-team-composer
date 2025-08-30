using System.Net;
using System.Text.Json;
using Composer.Core;
using Composer.Core.Models;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Composer.Functions;

public sealed class HeroesFunction
{
    private readonly Roster _roster;
    public HeroesFunction(IRosterProvider rosterProvider) => _roster = rosterProvider.GetAsync().GetAwaiter().GetResult();

    [Function("heroes")]
    public async Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Anonymous, "get")] HttpRequestData req)
    {
        var list = _roster.Heroes.Values
            .Select(h => new { id = h.Id, name = h.Name, role = h.PrimaryRole.ToString(), tags = h.Tags })
            .OrderBy(x => x.name)
            .ToList();

        var res = req.CreateResponse(HttpStatusCode.OK);
        res.Headers.Add("Content-Type", "application/json");
        await res.WriteStringAsync(JsonSerializer.Serialize(list));
        return res;
    }
}