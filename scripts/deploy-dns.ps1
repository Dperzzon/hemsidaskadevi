# Driftsätter ENDAST Azure DNS-zonen för skadeviherrgard.com.
# Används manuellt (lokalt) när GitHub-workflow inte är tillgängligt.
# Kräver: az login mot Skadevis prenumeration, registrerad Microsoft.Network,
# rollen DNS Zone Contributor (eller motsvarande) på resursgruppen.
#
# Exempel:
#   ./scripts/deploy-dns.ps1                 # what-if (förhandsgranska)
#   ./scripts/deploy-dns.ps1 -Operation deploy   # genomför (kräver godkännande)

[CmdletBinding()]
param(
  [ValidateSet('what-if', 'deploy')]
  [string]$Operation = 'what-if',
  [string]$SubscriptionId = '7c9799f7-c50b-4450-8abd-159481748821',
  [string]$ResourceGroup = 'rg-skadevi-prod',
  [string]$DeploymentName = 'dns-skadeviherrgard'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repoRoot
try {
  Write-Host 'Bygger och verifierar att mallen endast innehåller DNS-resurser...'
  az bicep build --file infra/dns-skadeviherrgard.bicep --outfile infra/dns-skadeviherrgard.json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Bicep-build misslyckades.' }
  node scripts/verify-dns-template.mjs
  if ($LASTEXITCODE -ne 0) { throw 'DNS-mallens säkerhetskontroll misslyckades.' }

  $common = @(
    'deployment', 'group', $Operation,
    '--resource-group', $ResourceGroup,
    '--subscription', $SubscriptionId,
    '--name', $DeploymentName,
    '--template-file', 'infra/dns-skadeviherrgard.bicep',
    '--parameters', 'infra/dns-skadeviherrgard.bicepparam'
  )

  Write-Host "Kör az $($common -join ' ')"
  & az @common
  if ($LASTEXITCODE -ne 0) { throw "az deployment group $Operation misslyckades." }
} finally {
  Pop-Location
}
