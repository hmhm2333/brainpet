[CmdletBinding(DefaultParameterSetName = "Inventory")]
param(
  [Parameter(ParameterSetName = "Inventory")]
  [switch]$InventoryOnly,

  [Parameter(Mandatory = $true, ParameterSetName = "Interactive")]
  [switch]$RunInteractive,

  [string]$PortablePath = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($PortablePath)) { $PortablePath = Join-Path $scriptDirectory "..\dist-electron\BrainPet-3.4.0-win-x64.exe" }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $scriptDirectory "..\..\..\output\physical-acceptance" }
$scriptVersion = "brainpet-physical-v1"
$startedAt = Get-Date
$runId = $startedAt.ToString("yyyyMMdd-HHmmss")
$receiptDirectory = Join-Path ([System.IO.Path]::GetFullPath($OutputDirectory)) $runId
New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class BrainPetDpiProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")]
  private static extern IntPtr MonitorFromPoint(POINT point, uint flags);

  [DllImport("shcore.dll")]
  private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

  [DllImport("shcore.dll")]
  private static extern int SetProcessDpiAwareness(int awareness);

  public static void EnablePerMonitorAwareness() {
    SetProcessDpiAwareness(2);
  }

  public static uint GetEffectiveDpi(int x, int y) {
    POINT point = new POINT { X = x, Y = y };
    IntPtr monitor = MonitorFromPoint(point, 2);
    uint dpiX;
    uint dpiY;
    int result = GetDpiForMonitor(monitor, 0, out dpiX, out dpiY);
    return result == 0 ? dpiX : 0;
  }
}
"@

try { [BrainPetDpiProbe]::EnablePerMonitorAwareness() } catch { }

function Get-DisplayInventory {
  $index = 0
  return @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    $screen = $_
    $index += 1
    $probeX = $screen.Bounds.X + [Math]::Max(1, [Math]::Floor($screen.Bounds.Width / 2))
    $probeY = $screen.Bounds.Y + [Math]::Max(1, [Math]::Floor($screen.Bounds.Height / 2))
    $dpi = 0
    try { $dpi = [BrainPetDpiProbe]::GetEffectiveDpi($probeX, $probeY) } catch { $dpi = 0 }
    [pscustomobject]@{
      index = $index
      deviceName = $screen.DeviceName
      primary = $screen.Primary
      bounds = [pscustomobject]@{ x = $screen.Bounds.X; y = $screen.Bounds.Y; width = $screen.Bounds.Width; height = $screen.Bounds.Height }
      workingArea = [pscustomobject]@{ x = $screen.WorkingArea.X; y = $screen.WorkingArea.Y; width = $screen.WorkingArea.Width; height = $screen.WorkingArea.Height }
      dpi = if ($dpi -gt 0) { [int]$dpi } else { $null }
      scalePercent = if ($dpi -gt 0) { [int][Math]::Round(($dpi / 96.0) * 100) } else { $null }
    }
  })
}

function Get-PortableEvidence {
  param([string]$Path)
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    return [pscustomobject]@{ path = $resolved; exists = $false }
  }
  $item = Get-Item -LiteralPath $resolved
  $signatureStatus = "Unavailable"
  $signatureError = $null
  try {
    $securityModule = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
    Import-Module $securityModule -ErrorAction Stop
    $signatureStatus = [string](Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $resolved).Status
  } catch {
    $signatureError = $_.Exception.Message
  }
  $stream = [System.IO.File]::OpenRead($resolved)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $sha256 = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "") } finally { $sha.Dispose() }
  } finally {
    $stream.Dispose()
  }
  return [pscustomobject]@{
    path = $resolved
    exists = $true
    sizeBytes = $item.Length
    sha256 = $sha256
    signatureStatus = $signatureStatus
    signatureProbeError = $signatureError
  }
}

function Read-Check {
  param([string]$Id, [string]$Prompt, [bool]$Available = $true)
  if (-not $Available) {
    return [pscustomobject]@{ id = $Id; status = "not-available"; note = "Current hardware cannot perform this check." }
  }
  Write-Host ""
  Write-Host $Prompt -ForegroundColor Cyan
  do { $status = (Read-Host "Enter PASS, FAIL, or NA").Trim().ToUpperInvariant() } while ($status -notin @("PASS", "FAIL", "NA"))
  $note = Read-Host "Optional note or evidence path"
  return [pscustomobject]@{ id = $Id; status = $status.ToLowerInvariant(); note = $note }
}

function Write-Receipt {
  param([object]$Receipt)
  $jsonPath = Join-Path $receiptDirectory "brainpet-physical-receipt.json"
  $markdownPath = Join-Path $receiptDirectory "brainpet-physical-receipt.md"
  $Receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8
  $displayLines = @($Receipt.environment.displays | ForEach-Object { "- $($_.deviceName): $($_.bounds.width)x$($_.bounds.height), $($_.scalePercent)%, primary=$($_.primary)" })
  $checkLines = @($Receipt.checks | ForEach-Object { "- $($_.id): $($_.status) $($_.note)" })
  @(
    "# BrainPet physical acceptance receipt"
    ""
    "- Run: $($Receipt.runId)"
    "- Mode: $($Receipt.mode)"
    "- Status: $($Receipt.overallStatus)"
    "- Script: $($Receipt.scriptVersion)"
    "- OS: $($Receipt.environment.os.caption) $($Receipt.environment.os.version)"
    "- Portable SHA256: $($Receipt.portable.sha256)"
    ""
    "## Displays"
    ""
    $displayLines
    ""
    "## Checks"
    ""
    $checkLines
  ) | Set-Content -LiteralPath $markdownPath -Encoding UTF8
  return [pscustomobject]@{ json = $jsonPath; markdown = $markdownPath }
}

$displays = @(Get-DisplayInventory)
$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
$portable = Get-PortableEvidence -Path $PortablePath
$checks = @()
$mode = if ($RunInteractive) { "interactive" } else { "inventory" }
$overallStatus = "inventory-only"

if ($RunInteractive) {
  if (-not $portable.exists) { throw "Portable build not found: $($portable.path)" }
  Write-Host "BrainPet physical acceptance launches the portable build but never locks Windows, changes display settings, or stops processes." -ForegroundColor Yellow
  $reviewer = Read-Host "Reviewer identifier (name, initials, or team code)"
  Start-Process -FilePath $portable.path | Out-Null
  Write-Host "First startup can take about 90 seconds while the portable package extracts. Open the training stage before continuing."
  $checks += Read-Check -Id "primary-display-edges" -Prompt "Move the pet to all four primary-display edges and open the stage each time. It must remain inside the work area and follow the pet."
  $checks += Read-Check -Id "secondary-display-edges" -Prompt "Move the pet to all four secondary-display edges and open the stage each time. It must remain inside that work area and follow the pet." -Available ($displays.Count -ge 2)
  $distinctScales = @($displays | Where-Object { $null -ne $_.scalePercent } | Select-Object -ExpandProperty scalePercent -Unique)
  $checks += Read-Check -Id "mixed-dpi" -Prompt "Confirm that the physical displays use different scaling and that stage size, pixel edges, and hit targets remain correct." -Available ($displays.Count -ge 2 -and $distinctScales.Count -ge 2)
  $checks += Read-Check -Id "lock-unlock" -Prompt "During a task, press Win+L yourself. After unlock, the task must remain paused and resume from the same progress without counting lock time."
  $checks += Read-Check -Id "agent-completion" -Prompt "Have a real Agent finish during a task. The current trial/session must not close or reset; the result page must show the Agent completion notice."
  $checks += Read-Check -Id "dynamic-visual" -Prompt "Play one full round of each task. Check overflow, pixel clarity, stimulus distinction, feedback flicker, pause/end actions, and accidental default HTML controls."
  $requiredPassed = @($checks | Where-Object { $_.status -ne "pass" }).Count -eq 0
  $overallStatus = if ($requiredPassed -and $displays.Count -ge 2 -and $distinctScales.Count -ge 2) { "passed" } else { "incomplete" }
} else {
  $reviewer = ""
  $checks += [pscustomobject]@{ id = "hardware-capability"; status = if ($displays.Count -ge 2) { "available" } else { "not-available" }; note = "$($displays.Count) physical display surface(s) detected." }
}

$receipt = [pscustomobject]@{
  schemaVersion = 1
  scriptVersion = $scriptVersion
  runId = $runId
  startedAt = $startedAt.ToUniversalTime().ToString("o")
  completedAt = (Get-Date).ToUniversalTime().ToString("o")
  mode = $mode
  reviewer = $reviewer
  overallStatus = $overallStatus
  environment = [pscustomobject]@{
    os = [pscustomobject]@{ caption = $os.Caption; version = $os.Version; buildNumber = $os.BuildNumber; architecture = $os.OSArchitecture }
    powershell = $PSVersionTable.PSVersion.ToString()
    displayCount = $displays.Count
    displays = $displays
  }
  portable = $portable
  checks = $checks
}

$paths = Write-Receipt -Receipt $receipt
Write-Host "Receipt JSON: $($paths.json)"
Write-Host "Receipt Markdown: $($paths.markdown)"
Write-Host "Overall status: $overallStatus"
if ($RunInteractive -and $overallStatus -ne "passed") { exit 2 }
