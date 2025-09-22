using System.Net;
using Microsoft.Extensions.Logging;

namespace Composer.Functions.Services;

public sealed class RateLimitHandler : DelegatingHandler
{
    private readonly ILogger<RateLimitHandler> _log;
    private const int MaxRetries = 6;
    private static readonly TimeSpan MaxHeaderWait = TimeSpan.FromMinutes(5);

    public RateLimitHandler(ILogger<RateLimitHandler> log) => _log = log;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            var resp = await base.SendAsync(request, ct);

            if (!ShouldRetry(resp, attempt, out var wait))
                return resp;

            _log.LogWarning("HTTP {Status} on {Method} {Path}. Retry {Attempt} after {Delay}s",
                (int)resp.StatusCode, request.Method, request.RequestUri?.AbsolutePath, attempt, wait.TotalSeconds);

            resp.Dispose();
            await Task.Delay(wait, ct);
        }
    }

    private static bool ShouldRetry(HttpResponseMessage resp, int attempt, out TimeSpan wait)
    {
        wait = TimeSpan.Zero;
        var code = (int)resp.StatusCode;

        if (code is 429 or >= 500)
        {
            // 1) Honor server hints
            if (resp.Headers.TryGetValues("Retry-After", out var ra) &&
                int.TryParse(ra.FirstOrDefault(), out var secs))
                wait = TimeSpan.FromSeconds(Math.Min(secs, MaxHeaderWait.TotalSeconds));

            else if (resp.Headers.TryGetValues("X-RateLimit-Reset", out var reset) &&
                     long.TryParse(reset.FirstOrDefault(), out var unix))
            {
                var until = DateTimeOffset.FromUnixTimeSeconds(unix) - DateTimeOffset.UtcNow;
                if (until > TimeSpan.Zero) wait = until;
            }

            // 2) Fallback jittered backoff
            if (wait == TimeSpan.Zero)
            {
                var baseMs = Math.Min(1000 * Math.Pow(2, attempt - 1), 60_000); // cap 60s
                var jitter = 0.75 + Random.Shared.NextDouble() * 0.5;         // 0.75–1.25x
                wait = TimeSpan.FromMilliseconds(baseMs * jitter);
            }

            return attempt < MaxRetries;
        }
        return false;
    }
}