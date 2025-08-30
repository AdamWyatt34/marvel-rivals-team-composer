param location string = 'eastus'
@description('Region for Static Web App (SWA must be in specific regions)')
param swaLocation string = 'eastus2' // pick one of: westus2, centralus, eastus2, westeurope, eastasia
param appName string
@allowed([ 'dev', 'uat', 'prod' ])
param environment string = 'dev'

@description('Enable Azure OpenAI (account + deployment) and wire keys into Function App')
param enableOpenAI bool = false

@description('Azure OpenAI resource name (ignored if enableOpenAI=false)')
param openAiName string = 'aoai-${appName}-${environment}'
@description('Deployment name inside Azure OpenAI')
param openAiDeployment string = 'explainer'
@description('Model name for deployment (e.g., gpt-4o-mini, gpt-35-turbo)')
param openAiModel string = 'gpt-4o-mini'
@description('Model version (keep current default if unsure)')
param openAiModelVersion string = '2024-07-18'

var nameSuffix = '${appName}-${environment}'

module insights 'modules/insights.bicep' = {
  name: 'insights'
  params: { name: 'appi-${nameSuffix}', location: location }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: { name: toLower(replace('st${uniqueString(resourceGroup().id, nameSuffix)}','-','')), location: location }
}

module appconfig 'modules/appconfig.bicep' = {
  name: 'appconfig'
  params: {
    name: 'appc-${nameSuffix}-cfg'
    location: location
    initialMetaVersion: 'v1'
  }
}

module swa 'modules/staticwebapp.bicep' = {
  name: 'swa'
  params: {
    name: 'swa-${nameSuffix}'
    location: swaLocation
  }
}

var devOrigins = environment == 'dev' ? [
  'http://localhost:3000'
] : []
var swaOrigin = 'https://${swa.outputs.defaultHostname}'
var allowedOrigins = union([ swaOrigin ], devOrigins, ['https://marvelrivalsteamposer.com', 'https://www.marvelrivalsteamposer.com')

module openai 'modules/azureopenai.bicep' = if (enableOpenAI) {
  name: 'openai'
  params: {
    name: openAiName
    location: location
    deploymentName: openAiDeployment
    modelName: openAiModel
    modelVersion: openAiModelVersion
  }
}

var aoaiId = resourceId('Microsoft.CognitiveServices/accounts', openAiName)

/* AOAI values without touching module outputs */
var aoaiEndpointValue   = enableOpenAI ? reference(aoaiId, '2023-05-01', 'full').properties.endpoint : ''
var aoaiPrimaryKeyValue   = enableOpenAI ? listKeys(aoaiId, '2023-05-01').key1 : ''
var aoaiDeploymentValue   = enableOpenAI ? openAiDeployment : ''

module func 'modules/functionapp.bicep' = {
  name: 'func'
  params: {
    name: 'func-${nameSuffix}'
    location: location
    storageAccountName: storage.outputs.name
    appInsightsId: insights.outputs.id
    appConfigEndpoint: appconfig.outputs.endpoint
    blobEndpoint: storage.outputs.blobEndpoint
    metaContainer: 'meta'
    cacheMinutes: 5
    allowedOrigins: allowedOrigins
    openAiEnabled: enableOpenAI
    openAiEndpoint: aoaiEndpointValue
    openAiKey: aoaiPrimaryKeyValue
    openAiDeployment: aoaiDeploymentValue
  }
}

var funcName       = 'func-${nameSuffix}'
var appConfigName  = 'appc-${nameSuffix}-cfg'
var storageName    = toLower(replace('st${uniqueString(resourceGroup().id, nameSuffix)}','-',''))

resource funcSite 'Microsoft.Web/sites@2022-09-01' existing = {
  name: funcName
}

resource st 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageName
}

resource ac 'Microsoft.AppConfiguration/configurationStores@2023-03-01' existing = {
  name: appConfigName
}

/* RBAC: Function MI can read Blob + AppConfig data */
resource roleBlobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcSite.id, 'blob-data-reader')
  scope: st
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','2a2b9908-6ea1-4ae2-8e65-a410df84e7d1') // Storage Blob Data Reader
    principalId: func.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource roleAppConfigDataReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(funcSite.id, 'appconfig-data-reader')
  scope: ac
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','516239f1-63e1-4d78-a4de-a74fb236a071') // App Configuration Data Reader
    principalId: func.outputs.identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

/* Outputs used by CI */
output functionHost string          = func.outputs.defaultHostName
output functionName string          = func.outputs.name
output staticWebAppName string      = swa.outputs.name
output staticWebAppHost string      = swa.outputs.defaultHostname
output storageAccountName string    = storage.outputs.name
output storageBlobEndpoint string   = storage.outputs.blobEndpoint
output appConfigEndpoint string     = appconfig.outputs.endpoint
output openAiEndpoint string        = aoaiEndpointValue

