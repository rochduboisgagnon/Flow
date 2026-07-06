# focus-probe: answers ONE question per stdin line - "is the focused UI element
# editable text?" - so AGR Flow can decide: insert at the cursor, or leave the
# dictation on the clipboard. Positive-signal rule (plan 5.2): when in doubt,
# answer editable=false; the app then HOLDs (clipboard only) instead of typing
# blindly. A persistent process (spawned once, one "probe\n" per dictation)
# keeps the UIA init cost out of the per-utterance path.
#
# Why PowerShell over a compiled exe: the managed UI Automation client
# (System.Windows.Automation) loads cleanly here via the GAC, whereas a bare
# csc-built exe hit a native UIAutomationCore.dll resolution failure AND got
# quarantined by Defender as a fresh unsigned binary. This needs no build step
# and no toolchain - it uses only what ships with Windows.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$Edit = [System.Windows.Automation.ControlType]::Edit
$Document = [System.Windows.Automation.ControlType]::Document
$ComboBox = [System.Windows.Automation.ControlType]::ComboBox
$ValuePattern = [System.Windows.Automation.ValuePattern]::Pattern

function Probe-Once {
  try {
    $el = $null
    for ($i = 0; $i -lt 2 -and $null -eq $el; $i++) {
      try { $el = [System.Windows.Automation.AutomationElement]::FocusedElement }
      catch { Start-Sleep -Milliseconds 30 }
    }
    if ($null -eq $el) { return '{"editable":false,"control":"none","app":""}' }

    $ct = $el.Current.ControlType
    $control =
      if ($ct -eq $Edit) { 'edit' }
      elseif ($ct -eq $Document) { 'document' }
      elseif ($ct -eq $ComboBox) { 'combobox' }
      else { $ct.ProgrammaticName }

    $typeOk = ($ct -eq $Edit) -or ($ct -eq $Document) -or ($ct -eq $ComboBox)
    $stateOk = $el.Current.IsEnabled -and $el.Current.IsKeyboardFocusable
    $writable = $true
    $vp = $null
    if ($el.TryGetCurrentPattern($ValuePattern, [ref]$vp)) { $writable = -not $vp.Current.IsReadOnly }
    $password = $false
    try { $password = $el.Current.IsPassword } catch {}

    $app = ''
    try { $app = (Get-Process -Id $el.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}

    $editable = ($typeOk -and $stateOk -and $writable -and -not $password)
    $ctrlJson = $control -replace '\\', '\\' -replace '"', '\"'
    $appJson = $app -replace '\\', '\\' -replace '"', '\"'
    return ('{{"editable":{0},"control":"{1}","app":"{2}"}}' -f ($editable.ToString().ToLower()), $ctrlJson, $appJson)
  }
  catch {
    return '{"editable":false,"control":"error","app":""}'  # any doubt -> HOLD
  }
}

# Signal readiness, then serve one line per request until stdin closes.
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -ne 'probe') { continue }
  [Console]::Out.WriteLine((Probe-Once))
  [Console]::Out.Flush()
}
