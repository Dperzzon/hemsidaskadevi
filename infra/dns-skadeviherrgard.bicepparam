using './dns-skadeviherrgard.bicep'

// Azure DNS för skadeviherrgard.com — förberedelse inför Wix-utfasning (steg 6A).
// Inget deployas förrän namnserverbytet är godkänt. Värdena nedan är
// verifierade 2026-11-11 mot den befintliga webbappen (inga hemligheter).

param zoneName = 'skadeviherrgard.com'

param webAppHostName = 'hemsida-skadevi-prod.azurewebsites.net'

// properties.inboundIpAddress för hemsida-skadevi-prod (verifierat 2026-11-11
// i prenumeration 7c9799f7-c50b-4450-8abd-159481748821). ENDAST aktuell
// inbound-IP används — possibleInboundIpAddresses används inte.
param apexIpAddresses = [
  '51.12.73.240'
]

// properties.customDomainVerificationId för hemsida-skadevi-prod (publik token).
param customDomainVerificationId = '6F5AF8BB0F29ABC9E13FBBBEB0DBFB5EDF9A30315C6FB2BAE9EB8F7C0977C78C'

// 300 s under migreringen; höj till 3600 efter verifierad cutover.
param ttl = 300

// Resend aktiveras först när domänen är verifierad i Resend och de exakta
// DNS-värdena hämtats från dashboarden (inget påhittat värde får användas).
param enableResend = false
param resendDkimValue = ''
