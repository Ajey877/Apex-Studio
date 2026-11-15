# Adds a SECOND, VIRTUAL display to a GitHub Actions Windows runner, so the
# multi-monitor part of the P9 editor acceptance can run where there is one screen.
#
# WHAT THIS IS: an install of the open-source Virtual Display Driver (an indirect
# display driver, MIT licence), using the route its own project documents. Windows
# then enumerates a second monitor exactly as it would a physical one: it has its
# own scale, and a window moved onto it receives a real WM_DPICHANGED.
#
# WHAT THIS IS NOT: a physical monitor. Evidence produced with it must say
# "virtual second display". It proves the host's handling of per-monitor DPI; it
# says nothing about a particular graphics card, cable or panel.
#
# SAFETY: this installs a driver. It refuses to run anywhere but a GitHub Actions
# runner, which is discarded after the job. Both downloads are pinned by SHA-256
# and the script stops if either differs.
#
# Prints one line of JSON: { available, monitorCount, steps[], error? }.
param([int]$WaitSeconds = 45)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$steps = New-Object System.Collections.ArrayList
$result = [ordered]@{ available = $false; monitorCount = 0; steps = $steps }
function Step($name, $detail) { [void]$steps.Add([ordered]@{ step = $name; detail = [string]$detail }) }
function Finish { $result | ConvertTo-Json -Depth 8 -Compress; $global:LASTEXITCODE = 0; exit 0 }

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  $result['error'] = 'Refusing to install a display driver: this is not a GitHub-hosted Actions runner.'
  Finish
}

$downloads = @(
  @{ name = 'nefcon'; file = 'nefcon.zip'
     url = 'https://github.com/nefarius/nefcon/releases/download/v1.14.0/nefcon_v1.14.0.zip'
     sha256 = 'a15557da24a9efca203158de3b43b0eaf982db231f0194031f1ed428bc13e669' },
  @{ name = 'driver'; file = 'driver.zip'
     url = 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip'
     sha256 = 'e24210692b442b39af763536330ce78b423f19342b7a7792c26de3944e418b3a' }
)
$tool = Join-Path $PSScriptRoot 'windows-display-scale.ps1'
function Get-Display { (& $tool -Action query) | ConvertFrom-Json }

try {
  $before = Get-Display
  Step 'monitors-before' $before.monitorCount
  $work = Join-Path $env:RUNNER_TEMP 'apex-virtual-display'
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  foreach ($item in $downloads) {
    $target = Join-Path $work $item.file
    Invoke-WebRequest -Uri $item.url -OutFile $target -UseBasicParsing
    $hash = (Get-FileHash -Path $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $item.sha256) { throw "$($item.name): SHA-256 $hash does not match the pinned $($item.sha256)" }
    Step "$($item.name)-verified" $hash
    Expand-Archive -Path $target -DestinationPath (Join-Path $work $item.name) -Force
  }
  $inf = Get-ChildItem -Path (Join-Path $work 'driver') -Recurse -Filter '*.inf' | Select-Object -First 1
  $cat = Get-ChildItem -Path (Join-Path $work 'driver') -Recurse -Filter '*.cat' | Select-Object -First 1
  $nefcon = Get-ChildItem -Path (Join-Path $work 'nefcon') -Recurse -Filter 'nefconw.exe' |
    Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
  if (-not $inf -or -not $cat -or -not $nefcon) {
    $names = (Get-ChildItem -Path $work -Recurse -File | ForEach-Object { $_.FullName.Substring($work.Length + 1) }) -join '; '
    throw "expected files not found in the archives: $names"
  }
  Step 'driver-files' ((Get-ChildItem -Path $inf.DirectoryName -File | ForEach-Object Name) -join ', ')

  # The driver reads its settings (one 1920x1080 monitor by default) from here.
  $settingsHome = 'C:\VirtualDisplayDriver'
  New-Item -ItemType Directory -Path $settingsHome -Force | Out-Null
  Get-ChildItem -Path $inf.DirectoryName -File -Include '*.xml', '*.txt' -Recurse | Copy-Item -Destination $settingsHome -Force

  # Trust the publisher that signed the driver catalogue, so the install is silent.
  $certificates = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
  $certificates.Import([System.IO.File]::ReadAllBytes($cat.FullName))
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPublisher', 'LocalMachine')
  $store.Open('ReadWrite')
  foreach ($certificate in $certificates) { $store.Add($certificate) }
  $store.Close()
  Step 'publisher-certificates' (($certificates | ForEach-Object { $_.Subject }) -join ' | ')

  $install = Start-Process -FilePath $nefcon.FullName -ArgumentList @('install', "`"$($inf.FullName)`"", 'Root\MttVDD') `
    -WorkingDirectory $inf.DirectoryName -Wait -PassThru -WindowStyle Hidden
  Step 'nefcon-install-exit-code' $install.ExitCode

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $extended = $false
  do {
    Start-Sleep -Seconds 3
    $now = Get-Display
    if ($now.monitorCount -lt 2 -and -not $extended) {
      # The new display may be connected but not yet part of the desktop.
      $extend = (& $tool -Action extend) | ConvertFrom-Json
      Step 'extend-desktop-status' $extend.status
      $extended = $true
      $now = Get-Display
    }
  } while ($now.monitorCount -lt 2 -and (Get-Date) -lt $deadline)

  $result['monitorCount'] = $now.monitorCount
  $result['available'] = $now.monitorCount -ge 2
  $result['display'] = $now
  $device = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'ROOT\DISPLAY\*' -or $_.FriendlyName -match 'Virtual Display|MttVDD|IddSample' } |
    ForEach-Object { "$($_.FriendlyName) [$($_.Status)] $($_.InstanceId)" }
  Step 'pnp-device' ($device -join ' | ')
} catch {
  $result['error'] = $_.Exception.Message
}
Finish
