<#
  Mochitsuki: put the Quests on Wi-Fi, open the scene in each headset, and keep them connected.

  Run it with the headsets plugged in by USB (once per headset boot). It:
    1. switches every USB-connected Quest to adb over Wi-Fi (port 5555) and remembers its address
    2. connects to each headset over Wi-Fi and forwards its localhost:5174 to this laptop (adb reverse),
       which VS Code forwards on to the dev server
    3. opens the scene in each headset's browser: the first headset as the host, the others as joining
    4. keeps watching (Ctrl+C to stop): reconnects a headset that slept or dropped off Wi-Fi and puts
       its forward back; a headset plugged in again by USB (after a reboot) is switched to Wi-Fi again
  After step 3 the USB cables can come out.

  Options:
    -HostDevice <serial or IP>   which headset hosts (default: the first one found)
    -NoBrowser                   don't open the scene in the headsets
    -NoWatch                     set up and exit, don't keep watching
    -Port <n>                    dev server port (default 5174)

  First time on this laptop (PowerShell):
    iwr http://localhost:5174/tools/quest-wifi.ps1 -UseBasicParsing -OutFile "$HOME\quest-wifi.ps1"; powershell -ExecutionPolicy Bypass -File "$HOME\quest-wifi.ps1"
  After that, double-click quest-wifi.cmd in your home folder (this script writes it).

  The laptop and the headsets must be on the same Wi-Fi, and it must let devices reach each other
  (campus networks like eduroam often don't; a home router or a phone hotspot does).
#>
param(
  [int]$Port = 5174,
  [string]$HostDevice = '',
  [switch]$NoBrowser,
  [switch]$NoWatch
)
$ErrorActionPreference = 'Continue'
$StateFile = Join-Path $env:LOCALAPPDATA 'mochi-quest-wifi.json'

function Say([string]$text, [string]$color = 'Gray') { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text) -ForegroundColor $color }

# adb, its output as one string (stderr included)
function Invoke-Adb([string[]]$a) {
  $out = & adb @a 2>&1 | ForEach-Object { "$_" }
  return ($out -join "`n")
}

# serials of the devices adb can talk to now
function Get-Devices {
  $lines = (Invoke-Adb @('devices')) -split "`n"
  $list = @()
  foreach ($l in $lines) { if ($l -match '^(\S+)\s+device\s*$') { $list += $Matches[1] } }
  return $list
}

function Get-WifiIp([string]$serial) {
  $o = Invoke-Adb @('-s', $serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0')
  if ($o -match 'inet (\d+\.\d+\.\d+\.\d+)') { return $Matches[1] }
  return $null
}

function Load-State {
  if (Test-Path $StateFile) {
    # Windows PowerShell 5.1 emits a JSON array as one object: enumerate it explicitly
    try { $x = Get-Content $StateFile -Raw | ConvertFrom-Json; return @($x | ForEach-Object { $_ }) } catch { }
  }
  return @()
}
function Save-State($entries) { ConvertTo-Json -InputObject @($entries) | Set-Content -Path $StateFile -Encoding UTF8 }

# a USB-connected headset: switch it to adb over Wi-Fi, return { serial, ip, model }
function Enable-Wifi([string]$serial) {
  $ip = Get-WifiIp $serial
  $model = (Invoke-Adb @('-s', $serial, 'shell', 'getprop', 'ro.product.model')).Trim()
  if (-not $ip) { Say "$model ($serial) is not on Wi-Fi: connect it to the same network as this laptop." 'Yellow'; return $null }
  Invoke-Adb @('-s', $serial, 'tcpip', '5555') | Out-Null
  Say "$model ($serial) switched to Wi-Fi at $ip" 'Green'
  return [pscustomobject]@{ serial = $serial; ip = $ip; model = $model }
}

# connect over Wi-Fi and forward the port; returns the Wi-Fi device id, or $null
function Connect-Headset($e) {
  $id = "$($e.ip):5555"
  if ((Get-Devices) -notcontains $id) {
    $r = Invoke-Adb @('connect', $id)
    Start-Sleep -Milliseconds 400
    if ((Get-Devices) -notcontains $id) { return $null }
    Say "$($e.model) connected over Wi-Fi ($id)" 'Green'
  }
  $rev = Invoke-Adb @('-s', $id, 'reverse', '--list')
  if ($rev -notmatch "tcp:$Port") {
    Invoke-Adb @('-s', $id, 'reverse', "tcp:$Port", "tcp:$Port") | Out-Null
    Say "$($e.model): localhost:$Port forwarded to this laptop" 'Green'
  }
  return $id
}

function Open-Scene([string]$id, [string]$role, [string]$model) {
  $url = "http://localhost:$Port/?mp=$role"
  # quoted for the headset's shell; the trailing package keeps it in the Quest browser
  $o = Invoke-Adb @('-s', $id, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'$url'", 'com.oculus.browser')
  if ($o -match 'Error|Exception') { Say "$model couldn't open the browser by itself: open $url in it." 'Yellow' }
  else { Say "$model opened $url" 'Cyan' }
}

# ---------------------------------------------------------------------------------------------------------

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
  Say 'adb was not found. Install Android platform-tools (or Meta Quest Developer Hub) and make sure adb is on PATH.' 'Red'
  exit 1
}
Invoke-Adb @('start-server') | Out-Null

# a double-click launcher for next time
$launcher = Join-Path $HOME 'quest-wifi.cmd'
$self = $MyInvocation.MyCommand.Path
if ($self -and -not (Test-Path $launcher)) {
  Set-Content -Path $launcher -Encoding ASCII -Value "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" %*`r`npause"
  Say "Next time, double-click $launcher" 'Gray'
}

# is the dev server reachable from this laptop (VS Code's port forward)?
try { Invoke-WebRequest -Uri "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 4 | Out-Null; Say "Dev server reachable at http://localhost:$Port" 'Green' }
catch { Say "Can't reach http://localhost:$Port on this laptop. In VS Code (connected to the cluster), forward port $Port (Ports panel), then the headsets will load the scene." 'Yellow' }

# 1. USB headsets to Wi-Fi
$entries = @(Load-State)
if ((Invoke-Adb @('devices')) -match 'unauthorized') { Say 'A headset is asking to allow USB debugging: put it on, allow it (tick "always"), then run this again.' 'Yellow' }
$usb = @(Get-Devices | Where-Object { $_ -notmatch ':' -and $_ -notmatch '^emulator-' })
if ($usb.Count -eq 0 -and $entries.Count -eq 0) { Say 'No headsets found. Plug them in by USB (and allow USB debugging in the headset).' 'Red'; exit 1 }
foreach ($s in $usb) {
  $e = Enable-Wifi $s
  if ($e) { $entries = @($entries | Where-Object { $_.serial -ne $s }) + $e }
}
Save-State $entries
Start-Sleep -Seconds 2   # adbd restarts in Wi-Fi mode

# 2. connect over Wi-Fi and forward
$ids = @{}
foreach ($e in $entries) {
  $id = Connect-Headset $e
  if ($id) { $ids[$e.serial] = $id } else { Say "$($e.model) at $($e.ip) did not answer over Wi-Fi (asleep, another network, or rebooted: plug it in by USB and run this again)." 'Yellow' }
}

# 3. open the scene: one host, the rest join
if (-not $NoBrowser -and $ids.Count -gt 0) {
  $hostEntry = $entries | Where-Object { $ids.ContainsKey($_.serial) -and ($_.serial -eq $HostDevice -or $_.ip -eq $HostDevice) } | Select-Object -First 1
  if (-not $hostEntry) { $hostEntry = $entries | Where-Object { $ids.ContainsKey($_.serial) } | Select-Object -First 1 }
  foreach ($e in $entries) {
    if (-not $ids.ContainsKey($e.serial)) { continue }
    $role = 'join'
    if ($e.serial -eq $hostEntry.serial) { $role = 'host' }
    Open-Scene $ids[$e.serial] $role $e.model
  }
  if ($ids.Count -eq 1) { Say 'Only one headset is connected, so it hosts. Run this again when the other is plugged in.' 'Yellow' }
}
Say 'Set up. The USB cables can come out now.' 'Green'
if ($NoWatch) { exit 0 }

# 4. keep them connected
Say 'Watching the connections (Ctrl+C to stop)...' 'Gray'
$was = @{}
while ($true) {
  Start-Sleep -Seconds 5
  $now = @(Get-Devices)
  # a headset on USB again (a reboot turns Wi-Fi debugging off): switch it back
  foreach ($s in @($now | Where-Object { $_ -notmatch ':' -and $_ -notmatch '^emulator-' })) {
    $known = $entries | Where-Object { $_.serial -eq $s } | Select-Object -First 1
    if ($known -and ($now -contains "$($known.ip):5555")) { continue }
    $e = Enable-Wifi $s
    if ($e) { $entries = @($entries | Where-Object { $_.serial -ne $s }) + $e; Save-State $entries; Start-Sleep -Seconds 2 }
  }
  foreach ($e in $entries) {
    $id = Connect-Headset $e
    $ok = [bool]$id
    if ($was.ContainsKey($e.serial) -and $was[$e.serial] -and -not $ok) { Say "$($e.model) dropped off Wi-Fi; retrying every 5 s" 'Yellow' }
    $was[$e.serial] = $ok
  }
}
