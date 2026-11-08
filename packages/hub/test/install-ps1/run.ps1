# One install.ps1 scenario in a throwaway sandbox (see fakes.ps1). Throws, so the process exits
# non-zero, when an assertion fails; prints PASS otherwise. Driven by src/install/install-ps1.test.ts:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File run.ps1 -Scenario fnm -ScriptDir <dir>
#   pwsh -NoProfile -File run.ps1 -Scenario fnm -ScriptDir <dir>
#
# <dir> holds the rendered install.ps1 (site https://site.test, range ^0.3) and install-ext.ps1
# (the same with a ps1AfterCli extension).
param(
  [Parameter(Mandatory = $true)][string]$Scenario,
  [Parameter(Mandatory = $true)][string]$ScriptDir
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'fakes.ps1')
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$Installer = Join-Path $ScriptDir 'install.ps1'
$InstallerExt = Join-Path $ScriptDir 'install-ext.ps1'
$Site = 'https://site.test'
$InstallLine = 'npm install -g @uncage/cli@\^?0\.3'
$ChangeLine = '(install|default|alias|config set|fetch|setup|unalias)\b'

$script:sb = $null
$script:last = $null

function Fail([string]$Message) {
  $calls = (Get-Calls $script:sb) -join "`n"
  $userPath = ''
  if ($script:sb) { $userPath = (Get-UserPathEntries $script:sb) -join ';' }
  $out = ''
  if ($script:last) { $out = [string]$script:last.Out }
  throw ("ASSERTION FAILED: " + $Message + "`n--- output ---`n" + $out + "`n--- calls.log ---`n" + $calls + "`n--- user Path ---`n" + $userPath)
}

function Assert-That([bool]$Condition, [string]$Message) {
  if (-not $Condition) { Fail $Message }
}

function Assert-Code([int]$Expected) {
  Assert-That ($script:last.Code -eq $Expected) ("result code " + $script:last.Code + ", expected " + $Expected)
}

function Assert-Out([string]$Pattern) {
  Assert-That ($script:last.Out -match $Pattern) ("output does not match /" + $Pattern + "/")
}

function Assert-NoOut([string]$Pattern) {
  Assert-That (-not ($script:last.Out -match $Pattern)) ("output matches /" + $Pattern + "/")
}

function Test-Call([string]$Pattern) {
  foreach ($c in (Get-Calls $script:sb)) { if ($c -match $Pattern) { return $true } }
  return $false
}

function Assert-Call([string]$Pattern) {
  Assert-That (Test-Call $Pattern) ("no call matches /" + $Pattern + "/")
}

function Assert-NoCall([string]$Pattern) {
  Assert-That (-not (Test-Call $Pattern)) ("a call matches /" + $Pattern + "/")
}

# Entries equal to $Dir (separators and a trailing one ignored).
function Get-PathCount([string]$Dir) {
  $want = ($Dir -replace '[\\/]+', '/').TrimEnd('/')
  $n = 0
  foreach ($p in (Get-UserPathEntries $script:sb)) { if ((($p -replace '[\\/]+', '/').TrimEnd('/')) -ieq $want) { $n++ } }
  return $n
}

function Run([string]$Answers = '', [string[]]$Arguments = @(), [string]$Mode = 'file', [string]$Script = $Installer) {
  $script:last = Invoke-Installer -Sb $script:sb -Script $Script -Answers $Answers -Arguments $Arguments -Mode $Mode
  return $script:last
}

function Get-B64([string]$B64) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
}

$scenarios = @{
  'all-ready' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,y' | Out-Null
    Assert-Code 0
    Assert-Out 'Checking this computer'
    Assert-Out 'Windows (x64|arm64)'
    Assert-Out 'Node\.js 22\.23\.4'
    Assert-Out 'npm 10\.9\.2, global folder writable'
    Assert-Out 'Claude Code'
    Assert-Out 'Codex not found'
    Assert-Call $InstallLine
    Assert-Call ('^uncage setup ' + [regex]::Escape($Site) + '$')
    Assert-That (((Get-UserPathEntries $sb) -join ';') -eq 'C:\Existing\Tools') 'the user Path changed'
    # The P4 troubleshooting entry: under the default Restricted policy a bare `uncage` resolves to
    # npm's uncage.ps1 shim and is refused; uncage.cmd works. (Execution policy is Windows-only.)
    if ($FakeUnix) { return }
    $exe = (Get-Process -Id $PID).Path
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $shim = (@(& $exe -NoProfile -ExecutionPolicy Restricted -Command 'uncage --version' 2>&1) | ForEach-Object { [string]$_ }) -join "`n"
      $shimCode = $LASTEXITCODE
      $cmd = (@(& $exe -NoProfile -ExecutionPolicy Restricted -Command 'uncage.cmd --version' 2>&1) | ForEach-Object { [string]$_ }) -join "`n"
      $cmdCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prev
    }
    Assert-That (-not ($shim -match 'SHIM-RAN')) ("the uncage.ps1 shim ran under Restricted: " + $shim)
    Assert-That ($shimCode -ne 0) ("a bare uncage under Restricted exited 0: " + $shim)
    Assert-That ($cmd -match '0\.3\.0') ("uncage.cmd --version under Restricted: " + $cmd)
    Assert-That ($cmdCode -eq 0) ("uncage.cmd --version under Restricted exited " + $cmdCode)
  }

  'idempotent' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,n' | Out-Null
    Assert-Code 0
    Assert-Call $InstallLine
    Clear-Calls $sb
    Run -Answers 'y' | Out-Null
    Assert-Code 0
    Assert-Out 'Uncage CLI 0\.3\.0'
    Assert-NoCall 'npm install'
    Assert-Call '^uncage --version'
    Assert-Call ('^uncage setup ' + [regex]::Escape($Site))
  }

  'nvm-windows' = {
    Add-FakeNvm $sb | Out-Null
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,y,n' | Out-Null
    Assert-Code 0
    Assert-Out 'Node\.js not found'
    Assert-Call '^nvm install 22$'
    Assert-NoCall '^nvm use'
    Assert-Call ($InstallLine + '.*nvm[\\/]v22\.23\.4')
    Assert-Out 'nvm use 22\.23\.4'
    Assert-Out 'Node\.js 22 is not your default'
    Assert-NoCall '^uncage setup'
  }

  'fnm' = {
    Add-FakeTool $sb 'fnm'
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,n,y,n' | Out-Null
    Assert-Code 0
    Assert-Call '^fnm install 22$'
    Assert-NoCall '^fnm default 22'
    # fnm made its first Node.js the default by itself; "n" undoes it (no Node.js on PATH: unalias).
    Assert-Call '^fnm unalias default$'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $sb.Roaming 'fnm\aliases\default'))) 'the fnm default alias is still there'
    Assert-Out 'Undid the default fnm sets'
    Assert-Call ($InstallLine + '.*node-versions[\\/]v22\.23\.4[\\/]installation')
    Assert-That ((Get-UserPathEntries $sb).Count -eq 1) 'the user Path changed'
  }

  'volta' = {
    Add-FakeTool $sb 'volta'
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,n,y,n' | Out-Null
    Assert-Code 0
    Assert-Call '^volta fetch node@22$'
    Assert-NoCall '^volta install'
    # `volta run --node 22` would download before the Y: never used.
    Assert-NoCall '^volta run'
    Assert-Call ($InstallLine + '.*Volta[\\/]tools[\\/]image[\\/]node[\\/]22\.23\.4')
  }

  'winget-fnm' = {
    Add-FakeTool $sb 'winget'
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,y,y,n' | Out-Null
    Assert-Code 0
    Assert-Call '^winget install --id Schniz\.fnm -e --source winget --accept-package-agreements --accept-source-agreements$'
    Assert-NoCall 'OpenJS'
    Assert-Call '^fnm install 22$'
    Assert-Call '^fnm default 22$'
    Assert-That ((Get-PathCount (Join-Path $sb.Roaming 'fnm\aliases\default')) -eq 1) 'the fnm default alias folder is not on the user Path once'
    Assert-Call $InstallLine
  }

  'zip-fnm' = {
    Add-FakeFnmZip $sb | Out-Null
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,y,y,n' | Out-Null
    Assert-Code 0
    Assert-Call '^fnm install 22$'
    Assert-Call '^fnm default 22$'
    Assert-That (Test-Path -LiteralPath (Join-Path $sb.Local 'fnm\fnm.cmd')) 'fnm was not unpacked into %LOCALAPPDATA%\fnm'
    Assert-Call $InstallLine
    Clear-Calls $sb
    Run -Answers 'y,n' | Out-Null
    Assert-Code 0
    Assert-NoCall '^fnm install'
    Assert-NoCall 'npm install'
    Assert-That ((Get-PathCount (Join-Path $sb.Local 'fnm')) -eq 1) 'the fnm folder is not on the user Path exactly once after two runs'
    Assert-That ((Get-PathCount (Join-Path $sb.Roaming 'fnm\aliases\default')) -eq 1) 'the fnm default alias folder is not on the user Path exactly once after two runs'
    Assert-That (@(Get-ChildItem -LiteralPath $sb.Tmp -Filter 'uncage-install-*' -Force).Count -eq 0) 'a temp folder was left behind'
  }

  'npm-prefix' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    # The default prefix sits under a file, so nothing can be created there.
    $blocker = Join-Path $sb.Root 'blocker'
    [IO.File]::WriteAllText($blocker, '')
    [IO.File]::WriteAllText((Join-Path $sb.Bin '.npm-prefix'), (Join-Path $blocker 'npm'))
    Run -Answers 'y,y,n' | Out-Null
    Assert-Code 0
    Assert-Out 'is not writable without admin rights'
    $npmGlobal = Join-Path $sb.Home '.npm-global'
    Assert-Call ('^npm config set prefix "?.*home dir[\\/]\.npm-global')
    Assert-That ((Get-PathCount $npmGlobal) -eq 1) 'the npm folder is not on the user Path once'
    Assert-That (Test-Path -LiteralPath (Join-Path $npmGlobal 'uncage.cmd')) 'uncage.cmd is not in the new npm folder'
    Assert-Call $InstallLine
  }

  'non-interactive' = {
    Add-FakeTool $sb 'fnm'
    Add-FakeAgent $sb 'claude'
    Run | Out-Null
    Assert-Code 2
    Assert-Out 'no terminal to ask'
    Assert-Out "fnm(\.cmd)?' install 22"
    Assert-Out ('uncage\.cmd setup ' + [regex]::Escape($Site))
    Assert-Out 'UNCAGE_YES'
    Assert-NoCall ('^(fnm|npm|uncage) ' + $ChangeLine)
    # Like `irm | iex`: no exit, the result is in $LASTEXITCODE and the session goes on.
    Clear-Calls $sb
    Run -Mode 'iex' | Out-Null
    Assert-Out 'AFTER 2'
    Assert-NoCall ('^(fnm|npm|uncage) ' + $ChangeLine)
  }

  'answer-n' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    Run -Answers 'n' | Out-Null
    Assert-Code 0
    Assert-Out 'Skipped'
    Assert-Out ("npm-cli\.js' install -g '@uncage/cli@\^0\.3'")
    Assert-NoCall 'npm install'
    Assert-NoCall '^uncage setup'
  }

  'yes' = {
    Add-FakeFnmZip $sb | Out-Null
    Add-FakeAgent $sb 'claude'
    # An old Node.js in a Machine Path folder (not on this PATH) wins in new terminals.
    $machineNode = Join-Path $sb.Root 'program files node'
    Add-FakeNode $sb '18.20.0' $machineNode
    $machineFile = Join-Path $sb.Root 'machinepath.txt'
    [IO.File]::WriteAllText($machineFile, 'C:\Windows\System32;' + $machineNode)
    $env:UNCAGE_TEST_MACHINE_PATH_FILE = $machineFile
    Run -Arguments @('-Yes') -Mode 'scriptblock' | Out-Null
    Assert-Out 'AFTER 0'
    Assert-Out 'Y \(-Yes\)'
    Assert-Call '^fnm install 22$'
    # No Node.js at all before: -Yes also makes Node.js 22 the default...
    Assert-Call '^fnm default 22$'
    # ...but the Machine Path one still comes first, so it says so and prints the Path hint.
    Assert-Out 'Another Node\.js'
    Assert-NoOut 'is now your default'
    Assert-Out 'Node\.js 22 is not your default'
    Assert-Call $InstallLine
    Assert-Call ('^uncage setup ' + [regex]::Escape($Site))
  }

  'no-agent' = {
    Add-FakeNode $sb
    Run -Answers 'y' | Out-Null
    Assert-Code 0
    Assert-Out 'No AI coding agent found'
    Assert-Out 'irm https://claude\.ai/install\.ps1 \| iex'
    Assert-Call '^uncage runtimes --json'
    Assert-NoCall '^uncage setup'
  }

  # `uncage runtimes --json` lists a registered ACP agent whose handshake works and an installed
  # registry agent not registered yet; download-only, failing and not-installed rows are not agents.
  'acp-agents' = {
    Add-FakeNode $sb
    Copy-Item -LiteralPath (Join-Path $ScriptDir 'acp.json') -Destination (Join-Path $sb.Fakes 'acp')
    Run -Answers 'y,y' | Out-Null
    Assert-Code 0
    Assert-Call '^uncage runtimes --json'
    Assert-Out 'Claude Code \(ACP\) \(acp-claude\)'
    Assert-Out 'goose \(uncage runtimes enable goose\)'
    Assert-NoOut 'Gemini|OpenCode|fast-agent|Broken'
    Assert-NoOut 'No AI coding agent found'
    Assert-Call ('^uncage setup ' + [regex]::Escape($Site))
  }

  'acp-none' = {
    Add-FakeNode $sb
    Copy-Item -LiteralPath (Join-Path $ScriptDir 'acp-none.json') -Destination (Join-Path $sb.Fakes 'acp')
    Run -Answers 'y' | Out-Null
    Assert-Code 0
    Assert-Call '^uncage runtimes --json'
    Assert-Out 'No AI coding agent found'
    Assert-NoOut 'Gemini|fast-agent|Broken'
    Assert-NoCall '^uncage setup'
  }

  'npm-fails' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    [IO.File]::WriteAllText((Join-Path $sb.Fakes 'npm-fails'), '')
    Run -Answers 'y' | Out-Null
    Assert-Code 1
    Assert-Out 'npm install -g @uncage/cli@\^0\.3 failed'
    Assert-Out "npm-cli\.js' install -g '@uncage/cli@\^0\.3'"
    Assert-NoCall '^uncage setup'
  }

  'lang-zh' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    $env:UNCAGE_LANG = 'zh'
    Run -Answers 'n' | Out-Null
    Assert-Code 0
    Assert-NoOut 'Checking this computer'
    # The zh "checking" line (UTF-8, base64 so this file stays ASCII).
    Assert-Out ([regex]::Escape((Get-B64 '5q2j5Zyo5qOA5rWL6L+Z5Y+w55S16ISR4oCm4oCm')))
  }

  'lang-ja' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    Run -Answers 'n' -Arguments @('-Lang', 'ja') | Out-Null
    Assert-Code 0
    Assert-NoOut 'Checking this computer'
    # The ja "checking" line.
    Assert-Out ([regex]::Escape((Get-B64 '44GT44Gu44Kz44Oz44OU44Ol44O844K/44O844KS56K66KqN44GX44Gm44GE44G+44GZLi4u')))
  }

  'extension' = {
    Add-FakeNode $sb
    Add-FakeAgent $sb 'claude'
    Run -Answers 'y,n' -Script $InstallerExt | Out-Null
    Assert-Code 0
    Assert-Out "Running the website's extra install step"
    $marker = Join-Path $sb.Home 'extension.txt'
    Assert-That (Test-Path -LiteralPath $marker) 'the extension did not run'
    $text = [string](Get-Content -LiteralPath $marker -Raw)
    Assert-That ($text -match 'bin[\\/]uncage\.cmd') ("UNCAGE_BIN: " + $text)
    Assert-That ($text -match [regex]::Escape($Site)) ("UNCAGE_SITE_URL: " + $text)
    # Its own `exit 0` ended only its own process: the setup question still came.
    Assert-Out ('Connect this computer to ' + [regex]::Escape($Site) + ' now\?')
  }
}

if (-not $scenarios.ContainsKey($Scenario)) { throw ("unknown scenario " + $Scenario) }
$shellName = [IO.Path]::GetFileNameWithoutExtension((Get-Process -Id $PID).Path)
Write-Host ('=== install.ps1 scenario ' + $Scenario + ' under ' + $shellName + ' ' + $PSVersionTable.PSVersion)
$script:sb = New-UncageSandbox
$sb = $script:sb
$failure = $null
try {
  & $scenarios[$Scenario]
} catch {
  $failure = $_
} finally {
  # UNCAGE_PS1_LOG_DIR (set by the vitest driver): one log per scenario and shell, kept for CI.
  $logDir = [Environment]::GetEnvironmentVariable('UNCAGE_PS1_LOG_DIR')
  if ($logDir) {
    $out = ''
    if ($script:last) { $out = [string]$script:last.Out }
    $status = 'PASS'
    if ($failure) { $status = 'FAIL: ' + [string]$failure }
    $text = @('scenario: ' + $Scenario, 'shell: ' + $shellName + ' ' + $PSVersionTable.PSVersion, 'status: ' + $status, '--- last installer output ---', $out, '--- calls.log ---', ((Get-Calls $sb) -join "`n")) -join "`n"
    try {
      New-Item -ItemType Directory -Force -Path $logDir | Out-Null
      [IO.File]::WriteAllText((Join-Path $logDir ($shellName + '-' + $Scenario + '.log')), $text)
    } catch { }
  }
  Remove-UncageSandbox $script:sb
}
if ($failure) {
  Write-Host ('FAIL ' + $Scenario)
  Write-Host ([string]$failure)
  if ($failure.InvocationInfo) { Write-Host $failure.InvocationInfo.PositionMessage }
  exit 1
}
Write-Output ('PASS ' + $Scenario)
