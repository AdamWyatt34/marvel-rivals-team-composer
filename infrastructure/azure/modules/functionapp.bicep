param name string
param location string
param storageAccountName string
param appInsightsId string
param appConfigEndpoint string
param blobEndpoint string
param metaContainer string = 'meta'
param cacheMinutes int = 60

@description('Allowed origins for CORS (Function App)')
param allowedOrigins array = []

@description('Wire Azure OpenAI app settings')
param openAiEnabled bool = false
param openAiEndpoint string = ''
param openAiKey string = ''
param openAiDeployment string = ''
@description('Queue name used by the QueueTrigger for match details')
param matchDetailsQueueName string = 'match-details'
#disable-next-line no-hardcoded-env-urls
@description('Queue endpoint for MI access, e.g. https://<acct>.queue.core.windows.net')
param queueEndpoint string
@description('Key Vault Secret URI for the Marvel Rivals API key')
param marvelApiSecretUri string = ''  // pass in from main; empty means "not wired yet"

// Plan (Y1 = Consumption)
resource plan 'Microsoft.Web/serverfarms@2022-09-01' = {
  name: 'plan-${name}'
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'functionapp'
}

// Storage conn string
var storageId  = resourceId('Microsoft.Storage/storageAccounts', storageAccountName)
var storageKey = listKeys(storageId, '2023-01-01').keys[0].value
var storageConn = 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageKey};EndpointSuffix=core.windows.net'

// Insights connection string
var aiRef  = reference(appInsightsId, '2020-02-02', 'full')
var aiConn = empty(aiRef.properties.ConnectionString)
  ? 'InstrumentationKey=${aiRef.properties.InstrumentationKey}'
  : aiRef.properties.ConnectionString

// Base app settings
var baseAppSettings = [
  { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
  { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'dotnet-isolated' }
  { name: 'AzureWebJobsStorage', value: storageConn }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: aiConn }
  { name: 'AppConfig__Endpoint', value: appConfigEndpoint }
  { name: 'Storage__BlobEndpoint', value: blobEndpoint }
  { name: 'Meta__ContainerName', value: metaContainer }
  { name: 'Meta__CacheMinutes', value: string(cacheMinutes) }
  { name: 'Models__BlobEndpoint', value: blobEndpoint }
  { name: 'Models__ContainerName', value: 'models' }
  { name: 'Data__BlobEndpoint', value: blobEndpoint }
  { name: 'Data__ContainerName', value: 'data' }
  { name: 'UPDATE_CRON', value: '0 0 */5 * * *' }
  { name: 'ENQUEUE_CRON', value: '0 0 */1 * * *' }
  { name: 'INGEST__CrawlDelayMinutes', value: '60' }

  // enqueue knobs
  { name: 'ENQ__PlayersPerRun', value: '25' }
  { name: 'ENQ__MaxPagesPerPlayer', value: '6' }
  { name: 'ENQ__MaxSecondsPerPlayer', value: '150' }
  { name: 'ENQ__InterPageDelayMs', value: '200' }
  { name: 'ENQ__MaxMatchesEnqueued', value: '2000' }

  { name: 'Queue__ConnString', value: storageConn }
  { name: 'Queue__Endpoint', value: queueEndpoint }
  { name: 'Queue__MatchDetailsName', value: matchDetailsQueueName }
  { name: 'COUNTERS__LookbackDays', value: '60' }
  { name: 'Meta__Version',         value: 'v1' }
  { name: 'MRAPI__BaseUrl', value: 'https://marvelrivalsapi.com'}
#disable-next-line no-hardcoded-env-urls
  { name: 'MRAPI__Key', value: '@Microsoft.KeyVault(SecretUri=https://kv-rivals-comp-dev.vault.azure.net/secrets/MarvelRivals-ApiKey)' }
  // Optional but useful for zip deploys
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
]

// Optional AOAI app settings
var aoaiSettings = openAiEnabled ? [
  { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
  { name: 'AZURE_OPENAI_API_KEY', value: openAiKey }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: openAiDeployment }
  { name: 'USE_AZURE' , value: 'true' }
] : []

resource site 'Microsoft.Web/sites@2022-09-01' = {
  name: name
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    httpsOnly: true
    serverFarmId: plan.id
    siteConfig: {
      cors: {
        allowedOrigins: allowedOrigins
        supportCredentials: false
      }
      appSettings: concat(baseAppSettings, aoaiSettings)
    }
  }
}

output name string               = site.name
output defaultHostName string    = site.properties.defaultHostName
output identityPrincipalId string = site.identity.principalId
