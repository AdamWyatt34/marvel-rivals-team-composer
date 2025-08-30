using Composer.Core.Models;

namespace Composer.Core;

public interface IRosterProvider
{
    Task<Roster> GetAsync(CancellationToken ct = default);
}