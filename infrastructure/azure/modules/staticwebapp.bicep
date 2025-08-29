param name string
param location string
@allowed([ 'Free', 'Standard' ])
param skuName string = 'Free'

// Note: No repo wiring here because you deploy via GitHub Action.
// Just create the Static Web App shell resource.

resource swa 'Microsoft.Web/staticSites@2022-09-01' = {
  name: name
  location: location
  sku: {
    name: skuName
    tier: skuName
  }
  // properties can be empty when not linking a repo
  properties: {}
}

output name string            = swa.name
output defaultHostname string = swa.properties.defaultHostname
