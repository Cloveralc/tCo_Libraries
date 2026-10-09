$ErrorActionPreference = 'Stop'
$introDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$assetsDirectory = Split-Path -Parent $introDirectory
$readmePath = Join-Path $introDirectory 'README.md'
$appPath = Join-Path $assetsDirectory 'js\app.js'

if (-not (Test-Path -LiteralPath $readmePath)) { throw "README source not found: $readmePath" }
if (-not (Test-Path -LiteralPath $appPath)) { throw "Application script not found: $appPath" }

$readmeBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($readmePath))
$source = [IO.File]::ReadAllText($appPath)
$pattern = "const README_BASE64='[^']*';"
if (-not [regex]::IsMatch($source, $pattern)) { throw 'README_BASE64 constant was not found in app.js' }
$replacement = "const README_BASE64='$readmeBase64';"
$updated = [regex]::Replace($source, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement }, 1)
[IO.File]::WriteAllText($appPath, $updated, [Text.UTF8Encoding]::new($false))
Write-Output 'README synchronized to assets/js/app.js.'

