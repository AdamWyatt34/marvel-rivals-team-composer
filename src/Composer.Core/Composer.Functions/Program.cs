using Composer.Core;
using Composer.Core.Models;
using Composer.Functions.Services;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

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

if (string.Equals(config["USE_AZURE"], "true", StringComparison.OrdinalIgnoreCase))
{
    builder.Services.AddSingleton<IRosterProvider, AzureRosterProvider>();
}
else
{
    // local fallback provider
    builder.Services.AddSingleton<IRosterProvider>(sp =>
    {
        var metaPath = Path.Combine(Directory.GetCurrentDirectory(), "meta");
        var roster = RosterLoader.LoadFromFolder(metaPath);
        return new LocalRosterProvider(roster); // tiny wrapper below
    });
}
services.AddSingleton<Composer.Core.Composer>();
services.AddSingleton<BanRecommender>();

services.AddMemoryCache();
services.AddHttpClient();
services.AddSingleton<IExplainer, Explainer>(); // uses env vars; OK if unset

builder.Build().Run();

sealed class LocalRosterProvider : IRosterProvider
{
    private readonly Roster _roster;
    public LocalRosterProvider(Roster roster) => _roster = roster;
    public Task<Roster> GetAsync(CancellationToken ct = default) => Task.FromResult(_roster);
}