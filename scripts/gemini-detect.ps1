<#
.SYNOPSIS
  Reproduce LLM-CO-WIKI's Gemini CLI detection from a terminal.

.DESCRIPTION
  Prints the same [GEMINI DETECT] report the app shows in
  Settings -> LLM Models, so a machine that cannot export files can still
  hand over a diagnosis: read it off the screen, type it into the ticket.

  It matters that this uses System.Diagnostics.Process with
  UseShellExecute = $false. That is the same Win32 path the app's Rust code
  takes, so "does the OS accept gemini.cmd directly" is answered the same way
  here as in the app. PowerShell's own call operator (`& gemini --version`)
  runs batch files through its own handling and would hide that difference.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\gemini-detect.ps1

.NOTES
  Works on Windows PowerShell 5.1 and PowerShell 7+.
#>

$ErrorActionPreference = 'Continue'

# Match the app: one short line per stream, capped, so the report stays
# something a person can copy by hand.
$SnippetChars = 120
$TimeoutMs = 30000

function Format-Snippet([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return '(empty)' }
  $joined = ($Text -split '\s+' | Where-Object { $_ -ne '' }) -join ' '
  if ($joined.Length -gt $SnippetChars) { return $joined.Substring(0, $SnippetChars) + '...' }
  return $joined
}

function Invoke-Probe([string]$File, [string]$Arguments) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $p = [Diagnostics.Process]::Start($psi)
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ Started = $false; Detail = $_.Exception.Message; Ms = $sw.ElapsedMilliseconds }
  }

  # Read both pipes before waiting: a full pipe buffer would otherwise block
  # the child and look like a hang.
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutMs)) {
    try { $p.Kill() } catch { }
    $sw.Stop()
    return [pscustomobject]@{ Started = $true; TimedOut = $true; Ms = $sw.ElapsedMilliseconds }
  }
  $sw.Stop()
  return [pscustomobject]@{
    Started  = $true
    TimedOut = $false
    Code     = $p.ExitCode
    Out      = $stdout.Result
    Err      = $stderr.Result
    Ms       = $sw.ElapsedMilliseconds
  }
}

$lines = @('[GEMINI DETECT]')

# 1. Resolve, in the same candidate order the app uses.
$resolved = $null
foreach ($candidate in 'gemini.cmd', 'gemini.exe', 'gemini') {
  $found = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($found) { $resolved = $found; break }
}

if (-not $resolved) {
  $lines += '1 resolve  FAIL  not on PATH'
  $lines += '  candidates: gemini.cmd, gemini.exe, gemini'
  $lines += '=> NOT FOUND'
  $lines -join "`n"
  exit 1
}

$path = $resolved.Source
$lines += "1 resolve  OK    $path"

# 2. The app prepends a login-shell PATH on macOS/Linux only; on Windows the
#    child inherits PATH unchanged. Report node, since the shim needs it.
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$lines += "2 node      $(if ($node) { $node.Source } else { 'NOT ON PATH' })"

# 3. Direct spawn — the app's default.
$probe = Invoke-Probe -File $path -Arguments '--version'
$launch = 'direct'

# 4. A batch shim the OS refused gets one retry through cmd.exe, same as the app.
if (-not $probe.Started -and $path -match '\.(cmd|bat)$') {
  $lines += "3 launch   direct -> spawn FAIL after $($probe.Ms)ms"
  $lines += "  detail   $(Format-Snippet $probe.Detail)"
  $probe = Invoke-Probe -File 'cmd.exe' -Arguments "/C `"$path`" --version"
  $launch = 'cmd /C (batch shim)'
}

$step = $lines.Count
if (-not $probe.Started) {
  $lines += "$step launch   $launch -> spawn FAIL after $($probe.Ms)ms"
  $lines += "  detail   $(Format-Snippet $probe.Detail)"
  $lines += '=> FAILED (could not start the process)'
} elseif ($probe.TimedOut) {
  $lines += "$step launch   $launch -> TIMEOUT after $([int]($TimeoutMs / 1000))s"
  $lines += '=> FAILED (timed out)'
} else {
  $version = ($probe.Out -split '\r?\n' | ForEach-Object { $_.Trim() } |
    Where-Object { $_ -ne '' } | Select-Object -Last 1)
  $lines += "$step launch   $launch -> exit $($probe.Code) in $($probe.Ms)ms"
  $lines += "  stdout   $(Format-Snippet $probe.Out)"
  $lines += "  stderr   $(Format-Snippet $probe.Err)"
  if ($probe.Code -eq 0) {
    $lines += "=> INSTALLED $(if ($version) { $version } else { '(no version line)' })"
  } else {
    $lines += '=> FAILED (CLI ran and reported an error)'
  }
}

$lines -join "`n"
