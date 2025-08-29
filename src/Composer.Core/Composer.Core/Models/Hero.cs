namespace Composer.Core.Models;

public sealed record Hero(string Id, string Name, Role PrimaryRole, string[] Tags);