using Composer.Core;
using Composer.Core.Models;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

var builder = FunctionsApplication.CreateBuilder(args);

builder.ConfigureFunctionsWebApplication();

builder.Services
    .AddApplicationInsightsTelemetryWorkerService()
    .ConfigureFunctionsApplicationInsights();

var config = new ConfigurationBuilder()
    .AddConfiguration(builder.Configuration)
    .AddJsonFile("appsettings.json", optional: true, reloadOnChange: true)
    .AddEnvironmentVariables()
    .Build();

builder.Configuration.AddConfiguration(config);
builder.Services.AddSingleton<IConfiguration>(config);

var services = builder.Services;

var cfg = builder.Configuration;

services.AddSingleton<IRosterProvider, AzureRosterProvider>(); // used only if USE_AZURE=true

services.AddSingleton<Roster>(sp =>
{
    var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger("RosterInit");
    var useAzure = string.Equals(cfg["USE_AZURE"], "true", StringComparison.OrdinalIgnoreCase);

    if (useAzure)
    {
        try
        {
            var provider = sp.GetRequiredService<IRosterProvider>();
            // NOTE: single sync wait during startup; wrapped in try/catch with fallback
            return provider.GetAsync().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Azure roster load failed — falling back to local /meta");
        }
    }

    // Fallback: load from bundled meta folder so startup never crashes
    var metaPath = Path.Combine(Directory.GetCurrentDirectory(), "meta");
    var roster = RosterLoader.LoadFromFolder(metaPath);
    logger.LogInformation("Loaded local roster from {Path}", metaPath);
    return roster;
});
services.AddSingleton<Composer.Core.Composer>();
services.AddSingleton<BanRecommender>();

services.AddMemoryCache();
services.AddHttpClient();
services.AddSingleton<IExplainer, Explainer>(); // uses env vars; OK if unset

builder.Build().Run();