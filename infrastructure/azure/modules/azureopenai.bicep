param name string
param location string
param deploymentName string = 'explainer'
param modelName string = 'gpt-4o-mini'
param modelVersion string = '2024-07-18'

resource aoai 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: name
  location: location
  kind: 'OpenAI'
  sku: {
    name: 'S0'
    tier: 'Free'
  }
  properties: {
    customSubDomainName: toLower(replace(name, '_', '-'))
    publicNetworkAccess: 'Enabled'
  }
}

resource dep 'Microsoft.CognitiveServices/accounts/deployments@2023-05-01' = {
  name: deploymentName
  parent: aoai
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
  sku: {
    name: 'Standard' // valid values include 'Standard'
    capacity: 1 // if your tenant doesn't allow capacity here, remove this line
  }
}

var keys = aoai.listKeys()

output endpoint string = aoai.properties.endpoint
output primaryKey string = keys.key1
output deploymentName string = deploymentName
