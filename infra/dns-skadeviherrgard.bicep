targetScope = 'resourceGroup'

// ============================================================================
// Azure DNS för skadeviherrgard.com — Wix-utfasning, steg 6A (FÖRBEREDELSE).
//
// Skapar den publika zonen och alla poster som behövs för att peka domänen mot
// Azure App Service INNAN namnservrarna byts. Ingen deployment får göras utan
// godkännande; mallen är fristående (deployas mot rg-skadevi-prod) och är inte
// inkopplad i infra/main.bicep ännu.
//
// Poster som skapas:
//   1. Apex A          -> App Service möjliga inbound-IP:er (båda, för robusthet)
//   2. www CNAME       -> hemsida-skadevi-prod.azurewebsites.net
//   3. TXT asuid       -> App Service-domänverifiering för rotdomänen
//   4. TXT asuid.www   -> App Service-domänverifiering för www
//   5. Resend-poster   -> ENDAST när enableResend=true och värden angivits
//                         (DKIM-nyckeln genereras av Resend och får aldrig hittas på)
//
// Varför A-post för apex: Azure DNS alias-poster kan inte peka på App Service.
// Endast appens AKTUELLA inboundIpAddress används som A-post (enligt beslut
// 2026-11-11). Värdet hämtas från rätt webbapp i rätt prenumeration:
//   az rest --method get --url "/subscriptions/<sub>/resourceGroups/<rg>/providers/
//     Microsoft.Web/sites/hemsida-skadevi-prod?api-version=2024-11-01" \
//     --query properties.inboundIpAddress
// Om appens inbound-IP ändras (t.ex. vid ombyggnad av planen) måste A-posten
// uppdateras — övervaka detta inför och efter cutover.
//
// TTL 300 s under migreringen — höj till 3600 när cutover verifierats.
// ============================================================================

@description('Zonnamn (måste matcha domänen exakt).')
param zoneName string = 'skadeviherrgard.com'

@description('Azure DNS-zoner är globala resurser; platsen ska vara "global".')
param location string = 'global'

@description('App Service AKTUELLA inbound-IP (A-post för rotdomänen). Hämtas från properties.inboundIpAddress — endast denna, inte possibleInboundIpAddresses.')
param apexIpAddresses array = [
  '51.12.73.240'
]

@description('Webbappens standardvärdnamn (CNAME-mål för www).')
param webAppHostName string = 'hemsida-skadevi-prod.azurewebsites.net'

@description('App Service custom domain verification ID (properties.customDomainVerificationId). Inte en hemlighet — används som TXT-värde för asuid-poster.')
param customDomainVerificationId string

@description('TTL i sekunder för migreringsposterna (300 under cutover, 3600 efter).')
@minValue(60)
@maxValue(86400)
param ttl int = 300

@description('Sätt true först när Resend-domänen ska verifieras (värdena hämtas från Resends dashboard).')
param enableResend bool = false

@description('Resends DKIM-värde för resend._domainkey (hela "p=..."-strängen från dashboarden).')
param resendDkimValue string = ''

@description('Resends SPF-post för send-subdomänen (från dashboarden).')
param resendSpfValue string = 'v=spf1 include:amazonses.com ~all'

@description('Resends MX-värd för send-subdomänen (regionens feedback-SMTP, från dashboarden).')
param resendMxExchange string = 'feedback-smtp.eu-west-1.amazonses.com'

@description('MX-prioritet för Resends återstudspost.')
param resendMxPreference int = 10

@description('Miljötagg.')
param environment string = 'prod'

@description('Ägartagg.')
param owner string = 'Skadevi Herrgård'

var tags = {
  Owner: owner
  Environment: environment
  ManagedBy: 'Bicep (Skadevi)'
}

resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: location
  tags: tags
}

// Rotdomänen: A-poster mot appens möjliga inbound-IP:er.
resource apexA 'Microsoft.Network/dnsZones/A@2018-05-01' = {
  parent: dnsZone
  name: '@'
  properties: {
    TTL: ttl
    ARecords: [for ip in apexIpAddresses: {
      ipv4Address: ip
    }]
  }
}

// www: CNAME till webbappens standardvärdnamn.
resource wwwCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: dnsZone
  name: 'www'
  properties: {
    TTL: ttl
    CNAMERecord: {
      cname: webAppHostName
    }
  }
}

// Domänverifiering för rotdomänen: TXT asuid.<zon>.
resource apexAsuid 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: dnsZone
  name: 'asuid'
  properties: {
    TTL: ttl
    TXTRecords: [
      {
        value: [customDomainVerificationId]
      }
    ]
  }
}

// Domänverifiering för www: TXT asuid.www.<zon>.
resource wwwAsuid 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: dnsZone
  name: 'asuid.www'
  properties: {
    TTL: ttl
    TXTRecords: [
      {
        value: [customDomainVerificationId]
      }
    ]
  }
}

// Resend: domänverifiering (DKIM) — värdet genereras av Resend.
resource resendDkim 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (enableResend && !empty(resendDkimValue)) {
  parent: dnsZone
  name: 'resend._domainkey'
  properties: {
    TTL: ttl
    TXTRecords: [
      {
        value: [resendDkimValue]
      }
    ]
  }
}

// Resend: SPF för sändningssubdomänen send.<zon>.
resource resendSpf 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (enableResend) {
  parent: dnsZone
  name: 'send'
  properties: {
    TTL: ttl
    TXTRecords: [
      {
        value: [resendSpfValue]
      }
    ]
  }
}

// Resend: MX för återstudsar (bounce/return-path) på send.<zon>.
// Krockar inte med rotdomänens MX eftersom posten ligger på subdomänen.
resource resendMx 'Microsoft.Network/dnsZones/MX@2018-05-01' = if (enableResend) {
  parent: dnsZone
  name: 'send'
  properties: {
    TTL: ttl
    MXRecords: [
      {
        preference: resendMxPreference
        exchange: resendMxExchange
      }
    ]
  }
}

output zoneId string = dnsZone.id
output zoneName string = dnsZone.name
output nameServers array = dnsZone.properties.nameServers
output apexFqdn string = apexA.name == '@' ? zoneName : '${apexA.name}.${zoneName}'
output wwwFqdn string = 'www.${zoneName}'
