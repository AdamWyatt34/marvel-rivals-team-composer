// modules/storage.bicep
param name string
param location string

@description('Queue name used by the ingestion pipeline')
param matchDetailsQueueName string = 'match-details'

resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: name
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

/* -------- Blob service + containers (new) -------- */
resource bs 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: sa
  name: 'default'
}

resource data 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: bs
  name: 'data'
  properties: {}
}

resource meta 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: bs
  name: 'meta'
  properties: {}
}

resource models 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: bs
  name: 'models'
  properties: {}
}

/* -------- Queue service + queue (existing) -------- */
resource qs 'Microsoft.Storage/storageAccounts/queueServices@2023-01-01' = {
  parent: sa
  name: 'default'
}

resource matchQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-01-01' = {
  parent: qs
  name: matchDetailsQueueName
}

var keys = sa.listKeys()

output name string = sa.name
output blobEndpoint string = 'https://${sa.name}.blob.${environment().suffixes.storage}'
output queueEndpoint string = 'https://${sa.name}.queue.${environment().suffixes.storage}'
output queueName string = matchDetailsQueueName
// Handy for the Function app's AzureWebJobsStorage
output connectionString string = 'DefaultEndpointsProtocol=https;AccountName=${sa.name};AccountKey=${keys.keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
