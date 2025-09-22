using Polly;
using Polly.Contrib.WaitAndRetry;

namespace Composer.Functions.Services;

public static class RetryPolicies
{
    public static IAsyncPolicy<HttpResponseMessage> GetRetryPolicy()
    {
        // Exponential backoff with jitter, up to ~6 tries
        var delays = Backoff.DecorrelatedJitterBackoffV2(TimeSpan.FromSeconds(1), retryCount: 6, fastFirst: true);

        return Policy<HttpResponseMessage>
            .HandleResult(r => (int)r.StatusCode >= 500)
            .WaitAndRetryAsync(delays);
    }
}