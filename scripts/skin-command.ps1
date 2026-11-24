# Ask a running hachiware-pet host to install a skin without the panel button.
# The host polls %APPDATA%\dsh-hachiware-pet\command.json every 1.2s, so this
# works even when the pet cannot be clicked.
#
#   powershell -File scripts\skin-command.ps1
#   powershell -File scripts\skin-command.ps1 -Slug nanami-hiromachi
#   powershell -File scripts\skin-command.ps1 -Random
param(
    [string]$Slug = "hachiware-2",
    [switch]$Random
)

$dir = Join-Path $env:APPDATA "dsh-hachiware-pet"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$target = Join-Path $dir "command.json"
if ($Random) {
    $body = '{"action":"new-skin"}'
} else {
    $body = '{"action":"install-skin","slug":"' + $Slug + '"}'
}
Set-Content -Path $target -Value $body -Encoding ascii -NoNewline
Write-Host "wrote $target ($body)"
