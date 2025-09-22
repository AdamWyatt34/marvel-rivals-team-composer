using System.Text.Json;
using Composer.Core;
using Composer.Functions.Extensions;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Composer.Functions;

public sealed class ModelCompareFunction
{
    private readonly IRosterProvider _rosterProvider;
    private readonly BlobLogRegScorer _lr;   // your existing LR scorer
    private readonly GbdtBlobScorer _gbdt;   // the GBDT scorer we added

    public ModelCompareFunction(IRosterProvider rosterProvider, BlobLogRegScorer lr, GbdtBlobScorer gbdt)
    {
        _rosterProvider = rosterProvider;
        _lr = lr;
        _gbdt = gbdt;
    }

    public sealed record CompareRequest(
        string[] ours,
        string[] enemy,
        string? map
    );

    [Function("model-compare")]
    public async Task<HttpResponseData> Run([HttpTrigger(AuthorizationLevel.Anonymous, "post")] HttpRequestData req, FunctionContext ctx)
    {
        CompareRequest? input;
        try
        {
            input = await JsonSerializer.DeserializeAsync<CompareRequest>(req.Body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (input is null) throw new Exception("Payload was null.");
        }
        catch (Exception ex)
        {
            return await req.BadRequestAsync($"Invalid payload: {ex.Message}");
        }

        static string Canon(string s) => (s ?? "").Trim().ToLowerInvariant();
        var ours  = input.ours.Select(Canon).ToArray();
        var enemy = input.enemy.Select(Canon).ToArray();

        var roster = await _rosterProvider.GetAsync();

        // validate ids
        var unknown = ours.Concat(enemy).Where(id => !roster.Heroes.ContainsKey(id)).Distinct().ToArray();
        if (unknown.Length > 0)
            return await req.BadRequestAsync(JsonSerializer.Serialize(new { error = "Unknown hero id(s)", ids = unknown }));

        // score
        var pLr   = await _lr.Score(ours, enemy, input.map ?? null, ctx.CancellationToken);
        var pGbdt = await _gbdt.Score(ours, enemy, input.map ?? null, ctx.CancellationToken);

        var resp = new
        {
            map = input.map,
            lr = new { prob = pLr },
            gbdt = new { prob = pGbdt },
            meta = new {
                ours = ours.Select(id => roster.Heroes[id].Name).ToArray(),
                enemy = enemy.Select(id => roster.Heroes[id].Name).ToArray()
            }
        };
        return await req.OkJsonAsync(resp);
    }
}