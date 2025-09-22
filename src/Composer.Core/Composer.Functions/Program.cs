using Composer.Core;
using Composer.Core.Models;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

var services = builder.Services;

var cfg = builder.Configuration;

var useAzure = (cfg["USE_AZURE"] ?? "false").Equals("true", StringComparison.OrdinalIgnoreCase);
if (useAzure)
{
    services.AddSingleton<IRosterProvider, AzureRosterProvider>();
    services.AddSingleton<Roster>(sp => sp.GetRequiredService<IRosterProvider>().GetAsync().GetAwaiter().GetResult());
}
else
{
    // Local loader reads from repo /meta
    var root = Directory.GetCurrentDirectory();
    var metaPath = Path.Combine(root, "meta");
    var roster = RosterLoader.LoadFromFolder(metaPath);
    services.AddSingleton<IRosterProvider, RosterLoader>();
    services.AddSingleton<Roster>(roster);
}

services.AddMemoryCache();
services.AddSingleton<Composer.Core.Composer>();
services.AddSingleton<BanRecommender>();
services.AddSingleton<ITeamScorer, GbdtBlobScorer>();
services.AddTransient<RateLimitHandler>();
services.AddHttpClient<IMarvelRivalsApi, MarvelRivalsApi>(http =>
{
    http.Timeout = TimeSpan.FromMinutes(7);
    http.BaseAddress = new Uri(cfg["MRAPI__BaseUrl"] ?? cfg["MRAPI:BaseUrl"] ?? "https://marvelrivalsapi.com");
    var key = cfg["MRAPI__Key"] ?? cfg["MRAPI:Key"];
    if (!string.IsNullOrEmpty(key))
        http.DefaultRequestHeaders.Add("x-api-key", key);
})
.AddHttpMessageHandler<RateLimitHandler>()
.AddPolicyHandler(RetryPolicies.GetRetryPolicy());


// Slug mapper
services.AddSingleton<IHeroSlugMapper, HeroSlugMapper>();

services.AddMemoryCache();
services.AddHttpClient();
services.AddSingleton<IExplainer, Explainer>(); // uses env vars; OK if unset

builder.Build().Run();