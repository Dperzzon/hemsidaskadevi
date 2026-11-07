using './main.bicep'

// Ändra värden här för att styra resursgrupp, Static Web App, regioner och taggar.
param resourceGroupName = 'rg-skadevi-prod'

param resourceGroupLocation = 'swedencentral'

param staticWebAppName = 'hemsida-skadevi-prod'

param staticWebAppLocation = 'westeurope'

param environment = 'prod'

param owner = 'Skadevi Herrgård'

param sku = 'Free'

param customDomain = 'www.skadeviherrgard.com'
