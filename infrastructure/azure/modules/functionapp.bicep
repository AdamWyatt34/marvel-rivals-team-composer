param name string
param location string
param storageAccountName string
param appInsightsId string
param appConfigEndpoint string
param blobEndpoint string
param metaContainer string = 'meta'
param cacheMinutes int = 5

@description('Allowed origins for CORS (Function App)')
param allowedOrigins array = []

@description('Wire Azure OpenAI app settings')
param openAiEnabled bool = false
param openAiEndpoint string = ''
param openAiKey string = ''
param openAiDeployment string = ''

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
var aiConn = reference(appInsightsId, '2020-02-02', 'Full').ConnectionString

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
  // Optional but useful for zip deploys
  { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
]

// Optional AOAI app settings
var aoaiSettings = openAiEnabled ? [
  { name: 'AZURE_OPENAI_ENDPOINT', value: openAiEndpoint }
  { name: 'AZURE_OPENAI_API_KEY', value: openAiKey }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: openAiDeployment }
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
