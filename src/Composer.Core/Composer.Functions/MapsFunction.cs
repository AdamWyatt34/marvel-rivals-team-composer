using Composer.Functions.Extensions;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Composer.Functions;

public sealed class MapsFunction
{
    public sealed record MapDto(string id, string name);
    
    private static readonly IReadOnlyDictionary<int, string> _maps = new Dictionary<int, string>
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

    [Function("maps")]
    public async Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Anonymous, "get")] HttpRequestData req)
    {
        var payload = _maps
            .DistinctBy(m => m.Value)
            .Select(m => new MapDto(m.Key.ToString(), m.Value))
            .OrderBy(m => m.name)
            .ToArray();
        return await req.OkJsonAsync(payload);
    }
}