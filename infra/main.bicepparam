using './main.bicep'

// Ändra värden här för att styra namn, region och taggar.
param staticWebAppName = 'hemsida-skadevi-prod'

param location = 'swedencentral'

param skuTier = 'Free'

param tags = {
  Owner: 'Skadevi Herrgård'
  Environment: 'prod'
  ManagedBy: 'GitHub Actions'
}
