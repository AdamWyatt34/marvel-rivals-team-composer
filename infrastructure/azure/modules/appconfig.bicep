param name string
param location string
@description('Seed the active meta version key')
param initialMetaVersion string = 'v1'

resource ac 'Microsoft.AppConfiguration/configurationStores@2023-03-01' = {
  name: name
  location: location
  sku: { name: 'Free' }
}

resource kv 'Microsoft.AppConfiguration/configurationStores/keyValues@2023-03-01' = {
  name: 'meta.currentVersion'
  parent: ac
  properties: {
    value: initialMetaVersion
    contentType: 'text/plain'
  }
}

output endpoint string = ac.properties.endpoint
output id string = ac.id
output name string = ac.name
