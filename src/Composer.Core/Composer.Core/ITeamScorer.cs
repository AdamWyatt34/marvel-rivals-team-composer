namespace Composer.Core;

public interface ITeamScorer
{
    Task<double> Score(IReadOnlyList<string> ourIds, IReadOnlyList<string> enemyIds, string? map = null, CancellationToken ct = default);
    IReadOnlyDictionary<string,double> EnemyImportance { get;  }
    bool TryGetHeroPriors(out IReadOnlyDictionary<string,double> priors);
    
}