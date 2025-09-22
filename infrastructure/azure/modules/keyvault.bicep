param name string
param location string
@description('Enable RBAC auth (preferred over access policies).')
param enableRbac bool = true

@secure()
@description('Initial Marvel Rivals API key value to seed. Leave empty to skip creating the secret.')
param marvelRivalsApiKey string = ''

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: enableRbac
    sku: { family: 'A', name: 'standard' }
    enabledForTemplateDeployment: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

@description('Create the secret if a value is provided')
resource apiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(marvelRivalsApiKey)) {
  parent: kv
  name: 'MarvelRivals-ApiKey'
  properties: {
    value: marvelRivalsApiKey
  }
}

output id string = kv.id
output name string = kv.name
output apiKeySecretId string = !empty(marvelRivalsApiKey)
  ? apiKeySecret.id
  : '${kv.id}/secrets/MarvelRivals-ApiKey'
