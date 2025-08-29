using System.Net;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker.Http;

namespace Composer.Functions.Extensions;

public static class HttpExtensions
{
    public static async Task<HttpResponseData> OkJsonAsync(this HttpRequestData req, object payload)
    {
        var res = req.CreateResponse(HttpStatusCode.OK);
        await res.WriteStringAsync(JsonSerializer.Serialize(payload));
        res.Headers.Add("Content-Type", "application/json");
        return res;
    }
    public static async Task<HttpResponseData> BadRequestAsync(this HttpRequestData req, string message)
    {
        var res = req.CreateResponse(HttpStatusCode.BadRequest);
        await res.WriteStringAsync(JsonSerializer.Serialize(new { error = message }));
        res.Headers.Add("Content-Type", "application/json");
        return res;
    }
}