# Decides whether the two-display lane of the P9 workflow may start.
#
# scripts/ci-install-virtual-display.ps1 REPORTS what happened and always exits 0.
# This script JUDGES: it exits 1 unless a virtual second display is really there.
# The two-display lane exists to run the multi-monitor cases (P9-D, P9-E, P9-F).
# If it cannot have two displays it must fail, not continue with one display and
# report those cases NOT_VERIFIED under a green job.
#
# It checks three independent things:
#   1. the installer's own report: available=true, no error, both pinned downloads
#      verified, the driver install exited 0;
#   2. Windows itself: at least two monitors now, more than before the install,
#      and every one of them offers the scales the acceptance needs;
#   3. the driver: a present "Virtual Display Driver" device whose status is OK.
#
# Prints one line of JSON: { ok, problems[], facts{} }. Exit code 0 = ok, 1 = not.
param(
  [string]$InstallerReport = '',
  [int]$MinimumMonitors = 2,
  [int]$MinimumScalePercent = 150
)

$ErrorActionPreference = 'Stop'
$problems = New-Object System.Collections.ArrayList
$facts = [ordered]@{}
function Problem($text) { [void]$problems.Add([string]$text) }

# 1. What the installer reported.
$info = $null
if (-not $InstallerReport) {
  Problem 'no installer report was given, so no virtual display was installed by this job'
} elseif (-not (Test-Path -LiteralPath $InstallerReport)) {
  Problem "the installer report '$InstallerReport' does not exist"
} else {
  try { $info = Get-Content -LiteralPath $InstallerReport -Raw | ConvertFrom-Json }
  catch { Problem "the installer report is not readable JSON: $($_.Exception.Message)" }
}
$monitorsBefore = $null
if ($info) {
  $facts['installerAvailable'] = $info.available
  $facts['installerMonitorCount'] = $info.monitorCount
  if ($info.available -ne $true) { Problem "the installer reported available=$($info.available)" }
  if ($info.error) {
    $facts['installerError'] = [string]$info.error
    Problem "the installer reported an error: $($info.error)"
  }
  $recorded = @{}
  foreach ($step in @($info.steps)) { if ($step) { $recorded[[string]$step.step] = [string]$step.detail } }
  foreach ($required in @('nefcon-verified', 'driver-verified')) {
    if (-not $recorded.ContainsKey($required)) { Problem "the installer did not record '$required': the pinned download was not verified" }
  }
  if (-not $recorded.ContainsKey('nefcon-install-exit-code')) {
    Problem 'the installer did not reach the driver install'
  } elseif ($recorded['nefcon-install-exit-code'] -ne '0') {
    Problem "the driver install exited $($recorded['nefcon-install-exit-code'])"
  }
  if ($recorded.ContainsKey('monitors-before')) {
    $monitorsBefore = [int]$recorded['monitors-before']
    $facts['monitorsBeforeInstall'] = $monitorsBefore
  }
}

# 2. What Windows reports now, asked independently of the installer.
$tool = Join-Path $PSScriptRoot 'windows-display-scale.ps1'
$state = $null
try { $state = (& $tool -Action query) | ConvertFrom-Json }
catch { Problem "Windows could not be asked for its displays: $($_.Exception.Message)" }
if ($state) {
  $monitors = @($state.monitors)
  $sources = @($state.sources)
  $facts['monitorCount'] = $state.monitorCount
  $facts['monitors'] = @($monitors | ForEach-Object { "$($_.device) $($_.width)x$($_.height) at ($($_.left),$($_.top)) $($_.effectiveDpi) DPI" })
  if ($state.monitorCount -lt $MinimumMonitors -or $monitors.Count -lt $MinimumMonitors) {
    Problem "Windows reports $($state.monitorCount) monitor(s); $MinimumMonitors are required"
  }
  if ($null -ne $monitorsBefore -and $state.monitorCount -le $monitorsBefore) {
    Problem "Windows reports $($state.monitorCount) monitor(s), no more than the $monitorsBefore before the install: the install added no display"
  }
  $scales = New-Object System.Collections.ArrayList
  foreach ($monitor in $monitors) {
    $source = $sources | Where-Object { $_.device -eq $monitor.device } | Select-Object -First 1
    if (-not $source) {
      Problem "Windows lists no scale settings for $($monitor.device)"
    } else {
      [void]$scales.Add("$($monitor.device) up to $($source.maximumPercent)%")
      if ($source.maximumPercent -lt $MinimumScalePercent) {
        Problem "$($monitor.device) offers at most $($source.maximumPercent)%; the acceptance needs $MinimumScalePercent%"
      }
    }
  }
  $facts['scales'] = @($scales)
}

# 3. The driver that provides the second display.
$devices = @()
try {
  $devices = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -eq 'Virtual Display Driver' -and $_.InstanceId -like 'ROOT\DISPLAY\*' })
} catch { Problem "the device list could not be read: $($_.Exception.Message)" }
$facts['virtualDisplayDevices'] = @($devices | ForEach-Object { "$($_.FriendlyName) [$($_.Status)] $($_.InstanceId) problem=$($_.ConfigManagerErrorCode)" })
if ($devices.Count -eq 0) {
  Problem 'no present "Virtual Display Driver" device (ROOT\DISPLAY\*) is installed'
} else {
  $working = @($devices | Where-Object { $_.Status -eq 'OK' })
  if ($working.Count -eq 0) {
    Problem "the Virtual Display Driver device is installed but not operational: $($facts['virtualDisplayDevices'] -join ' | ')"
  }
}

$ok = $problems.Count -eq 0
[ordered]@{ ok = $ok; problems = @($problems); facts = $facts } | ConvertTo-Json -Depth 6 -Compress
if ($ok) { exit 0 }
exit 1
