[CmdletBinding(DefaultParameterSetName = "Inventory")]
param(
  [Parameter(ParameterSetName = "Inventory")]
  [switch]$InventoryOnly,

  [Parameter(Mandatory = $true, ParameterSetName = "Interactive")]
  [switch]$RunInteractive,

  [Alias("PortablePath")]
  [string]$ArtifactPath = "",
  [string]$OutputDirectory = "",
  [ValidateSet("windows-x64")]
  [string]$TargetId = "windows-x64",
  [string]$SourceCommit = ""
)

$ErrorActionPreference = "Stop"
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ArtifactPath)) { $ArtifactPath = Join-Path $scriptDirectory "..\dist-brainpet\public-release\BrainPet-Unsigned-3.4.0-win-x64-setup.exe" }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $scriptDirectory "..\..\..\output\physical-acceptance" }
$scriptVersion = "brainpet-release-v4.0"
$startedAt = Get-Date
$runId = "$($startedAt.ToString('yyyyMMdd-HHmmss-fff'))-$PID"
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$receiptDirectory = Join-Path $outputRoot $runId
New-Item -ItemType Directory -Path $receiptDirectory -ErrorAction Stop | Out-Null

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

function Get-ArtifactEvidence {
  param([string]$Path)
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    return [pscustomobject]@{ name = [System.IO.Path]::GetFileName($resolved); exists = $false }
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
    kind = "nsis"
    name = $item.Name
    exists = $true
    sizeBytes = $item.Length
    sha256 = $sha256
    authenticodeStatus = $signatureStatus
    signatureProbeFailed = $null -ne $signatureError
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
  $note = Read-Host "Optional local-only note (do not enter paths, task content, or secrets)"
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
    "- Artifact SHA256: $($Receipt.artifact.sha256)"
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
$artifact = Get-ArtifactEvidence -Path $ArtifactPath
$checks = @()
$mode = if ($RunInteractive) { "interactive" } else { "inventory" }
$overallStatus = "inventory-only"

if ($RunInteractive) {
  if (-not $artifact.exists) { throw "Release installer not found: $([System.IO.Path]::GetFullPath($ArtifactPath))" }
  if ($artifact.authenticodeStatus -ne "NotSigned") { throw "Unsigned direct-release installer Authenticode status is $($artifact.authenticodeStatus), expected NotSigned." }
  if ($SourceCommit -notmatch '^[a-fA-F0-9]{40}$') { throw "RunInteractive requires -SourceCommit with the exact 40-character release commit." }
  Write-Host "BrainPet physical acceptance opens the explicitly unsigned installer but never disables SmartScreen, changes Windows security settings, locks Windows, changes display settings, or stops processes." -ForegroundColor Yellow
  $reviewer = Read-Host "Reviewer identifier (name, initials, or team code)"
  if ([string]::IsNullOrWhiteSpace($reviewer) -or $reviewer.Length -gt 128) { throw "Reviewer identifier must contain 1-128 characters." }
  Start-Process -FilePath ([System.IO.Path]::GetFullPath($ArtifactPath)) | Out-Null
  Write-Host "Complete the normal per-user install, first-run Agent connection, and the requested checks before recording each answer."
  $checks += Read-Check -Id "unsigned-security-prompt" -Prompt "Confirm the browser-downloaded Unsigned installer showed the Windows security/SmartScreen warning and you deliberately used the system-provided confirmation path. Do not disable SmartScreen."
  $checks += Read-Check -Id "clean-install" -Prompt "Confirm a new user can install the Unsigned NSIS package and reach BrainPet without opening a terminal after the one-time system confirmation."
  $checks += Read-Check -Id "default-install-path" -Prompt "Confirm BrainPet runs from the default per-user Programs\brainpet path."
  $checks += Read-Check -Id "no-development-toolchain" -Prompt "Confirm lifecycle and training work with Node, npm, pnpm, Cargo, and Rust removed from PATH."
  $checks += Read-Check -Id "default-discovery" -Prompt "Confirm the packaged Adapter discovers BrainPet without OPENPETS_DISCOVERY_FILE or another override."
  $checks += Read-Check -Id "adapter-first-lifecycle" -Prompt "Run a real Agent task and confirm the first lifecycle event wakes and updates exactly one BrainPet instance."
  $checks += Read-Check -Id "upgrade-state-preserved" -Prompt "Upgrade from the prior unsigned candidate and confirm progress plus Adapter connection are preserved or refreshed once."
  $checks += Read-Check -Id "uninstall-agent-fail-open" -Prompt "Uninstall BrainPet and confirm the Agent continues normally without Hook errors or a stale wakeup."
  $checks += Read-Check -Id "native-pet-recovery" -Prompt "Confirm uninstall does not remove or modify the Agent's native pet resources."
  $checks += Read-Check -Id "primary-display-edges" -Prompt "Move the pet to all four primary-display edges and open the stage each time. It must remain inside the work area and follow the pet."
  $checks += Read-Check -Id "secondary-display-edges" -Prompt "Move the pet to all four secondary-display edges and open the stage each time. It must remain inside that work area and follow the pet." -Available ($displays.Count -ge 2)
  $distinctScales = @($displays | Where-Object { $null -ne $_.scalePercent } | Select-Object -ExpandProperty scalePercent -Unique)
  $checks += Read-Check -Id "mixed-dpi" -Prompt "Confirm that the physical displays use different scaling and that stage size, pixel edges, and hit targets remain correct." -Available ($displays.Count -ge 2 -and $distinctScales.Count -ge 2)
  $checks += Read-Check -Id "sleep-wake" -Prompt "During a task, put Windows to sleep yourself. After wake, the task must safely pause/resume without creating another runtime instance."
  $checks += Read-Check -Id "agent-completion" -Prompt "Have a real Agent finish during a task. The current trial/session must not close or reset; the result page must show the Agent completion notice."
  $checks += Read-Check -Id "novice-rule-comprehension" -Prompt "Ask a first-time player to start without reading external instructions. By the end of level 1, they must correctly explain and perform each task rule without a separate tutorial page."
  $checks += Read-Check -Id "dynamic-visual" -Prompt "Play one full round of each task. Check overflow, pixel clarity, stimulus distinction, feedback flicker, pause/end actions, and accidental default HTML controls."
  $requiredPassed = @($checks | Where-Object { $_.status -ne "pass" }).Count -eq 0
  $overallStatus = if ($requiredPassed -and $displays.Count -ge 2 -and $distinctScales.Count -ge 2) { "passed" } else { "incomplete" }
} else {
  $reviewer = ""
  $checks += [pscustomobject]@{ id = "hardware-capability"; status = if ($displays.Count -ge 2) { "available" } else { "not-available" }; note = "$($displays.Count) physical display surface(s) detected." }
}

$receipt = [pscustomobject]@{
  schemaVersion = 4
  scriptVersion = $scriptVersion
  product = "brainpet"
  target = $TargetId
  sourceCommit = if ($SourceCommit -match '^[a-fA-F0-9]{40}$') { $SourceCommit.ToLowerInvariant() } elseif ($env:GITHUB_SHA -match '^[a-fA-F0-9]{40}$') { $env:GITHUB_SHA.ToLowerInvariant() } else { $null }
  runId = $runId
  startedAt = $startedAt.ToUniversalTime().ToString("o")
  completedAt = (Get-Date).ToUniversalTime().ToString("o")
  mode = $mode
  reviewer = $reviewer
  overallStatus = $overallStatus
  distributionChannel = "direct-download"
  platformSignatureStatus = "absent-by-policy"
  systemWarningObserved = @($checks | Where-Object { $_.id -eq "unsigned-security-prompt" -and $_.status -eq "pass" }).Count -eq 1
  userConsentConfirmed = @($checks | Where-Object { $_.id -eq "unsigned-security-prompt" -and $_.status -eq "pass" }).Count -eq 1
  environment = [pscustomobject]@{
    platform = "win32"
    arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    os = [pscustomobject]@{ caption = $os.Caption; version = $os.Version; buildNumber = $os.BuildNumber; architecture = $os.OSArchitecture }
    powershell = $PSVersionTable.PSVersion.ToString()
    displayCount = $displays.Count
    displays = $displays
  }
  artifact = $artifact
  artifactSha256 = $artifact.sha256
  checks = $checks
}

$paths = Write-Receipt -Receipt $receipt
Write-Host "Receipt JSON: $($paths.json)"
Write-Host "Receipt Markdown: $($paths.markdown)"
Write-Host "Overall status: $overallStatus"
if ($RunInteractive -and $overallStatus -ne "passed") { exit 2 }
