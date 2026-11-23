# Builds the Windows pet shell. The plugin host (index.js) calls this on first
# run when helper\bin\win\HachiwarePet.exe is missing; you can also run it by hand.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File helper-win\build.ps1
#
# Needs the .NET 8 SDK (not just the runtime). The result is framework
# dependent, so the target machine needs the .NET 8 Desktop Runtime:
#   winget install Microsoft.DotNet.DesktopRuntime.8
# For a machine without it, build self contained instead:
#   powershell -File helper-win\build.ps1 -SelfContained
param([switch]$SelfContained)

$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot '..\helper\bin\win'
$project = Join-Path $PSScriptRoot 'HachiwarePet.csproj'

$arguments = @('publish', $project, '-c', 'Release', '-r', 'win-x64', '--nologo', '-o', $out)
if ($SelfContained) {
  $arguments += @('--self-contained', 'true', '-p:PublishSingleFile=true')
} else {
  $arguments += @('--self-contained', 'false', '-p:PublishSingleFile=true')
}

dotnet @arguments
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
Write-Output "built $(Join-Path $out 'HachiwarePet.exe')"
