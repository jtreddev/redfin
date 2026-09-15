# Saves a full SQL copy of the production database to backups\ (git-ignored).
# Usage: npm run backup
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force backups | Out-Null
$file = "backups\fin-$(Get-Date -Format 'yyyy-MM-dd-HHmm').sql"
npx.cmd wrangler d1 export fin --remote --output $file
if ($LASTEXITCODE -ne 0) { throw "Backup failed" }
Write-Host "Saved $file"
