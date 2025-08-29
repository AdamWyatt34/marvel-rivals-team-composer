using Composer.Core;
using Composer.Core.Models;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

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
    services.AddSingleton<Roster>(roster);
}
services.AddSingleton<Composer.Core.Composer>();
services.AddSingleton<BanRecommender>();

services.AddMemoryCache();
services.AddHttpClient();
services.AddSingleton<IExplainer, Explainer>(); // uses env vars; OK if unset

builder.Build().Run();