# Uncage installer for Windows. It connects this computer to @@SITE_URL@@.
#
#   irm <site>/api/uncage/install.ps1 | iex                                  # asks [Y/n] before every change
#   & ([scriptblock]::Create((irm <site>/api/uncage/install.ps1))) -Yes      # confirms every install step
#
# What it does, in order: checks this computer; installs Node.js 22 when it is missing or too old
# (with your own version manager when you have one: nvm-windows, fnm or volta; otherwise fnm, per
# user, with winget or from its release zip) without changing your default Node.js unless you say
# Y; moves npm's global folder to %USERPROFILE%\.npm-global when it is not writable; installs the
# CLI with
#   npm install -g "@uncage/cli@@@CLI_RANGE@@"
# finds the AI coding agents you already have; and offers to run `uncage setup`.
# It never asks for admin rights, never installs Node.js with an MSI and never changes $PROFILE
# (PATH changes go to your user Path). Works in Windows PowerShell 5.1 and PowerShell 7.
# Options: -Yes, -NoSetup, -Lang en|zh|ja. Env: UNCAGE_YES=1, UNCAGE_NO_SETUP=1, UNCAGE_LANG.
# Exit codes: 0 done, 1 a step failed, 2 needs a terminal to confirm, 3 unsupported.
# Under `irm | iex` the result is in $LASTEXITCODE and the window stays open.
# Everything runs inside one script block, so a cut-off download defines nothing and runs nothing.
param([switch]$Yes, [switch]$NoSetup, [string]$Lang)

$uncageState = @{ Code = 1 }
& {
param([bool]$OptYes, [bool]$OptNoSetup, [string]$OptLang)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$U = @{}

function Set-UncageConfig {
  $U.CliRange = '@@CLI_RANGE@@'
  $U.CliSpec = '@uncage/cli@@@CLI_RANGE@@'
  $U.SiteUrl = '@@SITE_URL@@'
  $U.NodeMajor = 22
  $U.FnmZipUrl = 'https://github.com/Schniz/fnm/releases/latest/download/fnm-windows.zip'
  $U.WingetFnm = 'winget install --id Schniz.fnm -e --source winget --accept-package-agreements --accept-source-agreements'
}

# @@MESSAGES@@

# @@EXTENSION@@

# ---- output -----------------------------------------------------------------------------------

function Get-UMsg([string]$Key) {
  $t = $UncageMsgs[$U.Lang]
  if ($null -eq $t) { $t = $UncageMsgs['en'] }
  $b = $t[$Key]
  if (-not $b) { return $Key }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))
}

function Write-UErr([string]$Text) {
  try { [Console]::Error.WriteLine($Text) } catch { Write-Host $Text }
}

function Say([string]$Key) {
  Write-Host ((Get-UMsg $Key) -f $args)
}

function Warn([string]$Key) {
  Write-UErr ((Get-UMsg $Key) -f $args)
}

# A command to run by hand, indented.
function Write-UCmd([string]$Line) {
  Write-Host ('    ' + $Line)
}

function Write-UErrCmd([string]$Line) {
  Write-UErr ('    ' + $Line)
}

# Ends the run with a result code (caught in Invoke-UncageMain).
function Stop-Uncage([int]$Code) {
  $U.Code = $Code
  throw 'UNCAGE_STOP'
}

# A step failed: the reason, the commands to run by hand, result 1.
function Stop-UStep([string]$What, [string[]]$Cmds) {
  Warn 'step_failed' $What
  if ($Cmds -and $Cmds.Count -gt 0) {
    Warn 'manual_fix'
    foreach ($c in $Cmds) { Write-UErrCmd $c }
  }
  Stop-Uncage 1
}

# ---- options, language, terminal --------------------------------------------------------------

function Test-UTrue([string]$Value) {
  return ($Value -match '^(1|true|yes|y)$')
}

# -Lang > UNCAGE_LANG > the Windows display language (zh*, ja*) > en
function Read-UOptions {
  $U.Yes = $OptYes -or (Test-UTrue $env:UNCAGE_YES)
  $U.NoSetup = $OptNoSetup -or (Test-UTrue $env:UNCAGE_NO_SETUP)
  $l = $OptLang
  if (-not $l) { $l = $env:UNCAGE_LANG }
  if (-not $l) {
    try { $l = (Get-UICulture).Name } catch { $l = '' }
  }
  if ($l -like 'zh*') { $U.Lang = 'zh' } elseif ($l -like 'ja*') { $U.Lang = 'ja' } else { $U.Lang = 'en' }
}

# Answers come from Read-Host. UNCAGE_ANSWERS (comma-separated) replaces it in tests.
function Initialize-UInput {
  $U.Answers = $null
  $U.AnswerIdx = 0
  if ($env:UNCAGE_ANSWERS) {
    $U.Answers = @($env:UNCAGE_ANSWERS -split ',')
    $U.Interactive = $true
    return
  }
  $redirected = $true
  try { $redirected = [Console]::IsInputRedirected } catch { $redirected = $true }
  $nonInteractive = $false
  foreach ($a in [Environment]::GetCommandLineArgs()) {
    if ($a -match '^-noni') { $nonInteractive = $true }
  }
  $ci = $env:CI -and ($env:CI -ne 'false') -and ($env:CI -ne '0')
  $U.Interactive = -not ($redirected -or $nonInteractive -or $ci)
}

# Ask <message key> [args...]: $true for yes. An empty answer is yes; no answer at all is no.
function Ask([string]$Key) {
  $m = (Get-UMsg $Key) -f $args
  Write-Host -NoNewline ($m + ' [Y/n] ')
  if ($U.Yes) {
    Write-Host 'Y (-Yes)'
    return $true
  }
  $ans = $null
  if ($null -ne $U.Answers) {
    if ($U.AnswerIdx -ge $U.Answers.Count) {
      Write-Host ''
      return $false
    }
    $ans = $U.Answers[$U.AnswerIdx]
    $U.AnswerIdx = $U.AnswerIdx + 1
    Write-Host $ans
  } elseif ($U.Interactive) {
    try { $ans = Read-Host } catch { $ans = $null }
    if ($null -eq $ans) {
      Write-Host ''
      return $false
    }
  } else {
    Write-Host ''
    return $false
  }
  $a = ([string]$ans).Trim()
  return (($a -eq '') -or ($a -match '^(y|yes)$'))
}

# ---- small helpers ----------------------------------------------------------------------------

function Test-UFile([string]$Path) {
  if (-not $Path) { return $false }
  return (Test-Path -LiteralPath $Path -PathType Leaf)
}

function Test-UDir([string]$Path) {
  if (-not $Path) { return $false }
  return (Test-Path -LiteralPath $Path -PathType Container)
}

# The first program called $Name on PATH (.exe, .cmd, ...; never a .ps1), or ''.
function Find-UCmd([string]$Name) {
  $c = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [string]$c.Path }
  return ''
}

# $Dir\$Name.exe (or .cmd), or ''.
function Find-UExe([string]$Dir, [string]$Name) {
  if (-not $Dir) { return '' }
  foreach ($ext in @('.exe', '.cmd')) {
    $p = Join-Path $Dir ($Name + $ext)
    if (Test-UFile $p) { return $p }
  }
  return ''
}

# Runs a program for its output (stderr dropped). Returns the output as one string, '' on failure.
function Invoke-UQuery([string]$Exe, [string[]]$Argv) {
  if (-not $Exe) { return '' }
  $out = ''
  try {
    $lines = & $Exe @Argv 2>$null
    $out = (@($lines) | ForEach-Object { [string]$_ }) -join "`n"
  } catch {
    $out = ''
  }
  return $out
}

# Runs a program with its output on the console. The result is in $LASTEXITCODE (1 when it
# could not start at all).
function Invoke-UNative([string]$Exe, [string[]]$Argv) {
  $global:LASTEXITCODE = 1
  try {
    & $Exe @Argv
  } catch {
    Write-UErr ([string]$_)
    $global:LASTEXITCODE = 1
  }
}

# A PowerShell single-quoted literal, for printed commands.
function Format-ULiteral([string]$Text) {
  return ("'" + $Text.Replace("'", "''") + "'")
}

function Get-UFirstLine([string]$Text) {
  foreach ($l in ($Text -split "`r?`n")) {
    if ($l.Trim() -ne '') { return $l.Trim() }
  }
  return ''
}

function Get-USemver([string]$Text) {
  if ($Text -match '(\d+)\.(\d+)\.(\d+)') { return ($Matches[1] + '.' + $Matches[2] + '.' + $Matches[3]) }
  return ''
}

function Test-UNodeMajor([string]$Version) {
  if ($Version -match '^(\d+)\.') { return ([int]$Matches[1] -ge $U.NodeMajor) }
  return $false
}

# True when $Dir (or its nearest existing parent) takes a new file.
function Test-UWritable([string]$Dir) {
  $d = $Dir
  while ($d -and -not (Test-Path -LiteralPath $d)) {
    $up = Split-Path -Parent $d
    if (-not $up -or $up -eq $d) { return $false }
    $d = $up
  }
  if (-not (Test-UDir $d)) { return $false }
  $probe = Join-Path $d ('.uncage-write-test-' + [Guid]::NewGuid().ToString('N'))
  try {
    [IO.File]::WriteAllText($probe, '')
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

# Does installed version $Version satisfy the major.minor of the CLI range?
function Test-URange([string]$Version) {
  $r = $U.CliRange
  if ($r -eq 'latest' -or $r -eq 'next') { return $true }
  $op = ''
  if ($r.StartsWith('^')) {
    $op = '^'
    $r = $r.Substring(1)
  } elseif ($r.StartsWith('~')) {
    $op = '~'
    $r = $r.Substring(1)
  }
  if (-not ($r -match '^(\d+)(\.(\d+))?')) { return $false }
  $rmaj = [int]$Matches[1]
  $rmin = $null
  if ($Matches[3]) { $rmin = [int]$Matches[3] }
  if (-not ($Version -match '^(\d+)\.(\d+)')) { return $false }
  $vmaj = [int]$Matches[1]
  $vmin = [int]$Matches[2]
  if ($vmaj -ne $rmaj) { return $false }
  if ($null -eq $rmin) { return $true }
  if ($op -eq '^' -and $rmaj -gt 0) { return ($vmin -ge $rmin) }
  return ($vmin -eq $rmin)
}

# ---- the user Path (never $PROFILE: the default Restricted policy does not load it) ------------

function Get-UUserPath {
  if ($env:UNCAGE_TEST_USER_PATH_FILE) {
    if (-not (Test-UFile $env:UNCAGE_TEST_USER_PATH_FILE)) { return '' }
    return ([string](Get-Content -LiteralPath $env:UNCAGE_TEST_USER_PATH_FILE -Raw)).Trim()
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if ($null -eq $key) { return '' }
  try {
    # Raw value: entries like %USERPROFILE%\bin stay unexpanded when it is written back.
    return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {
    $key.Close()
  }
}

function Set-UUserPath([string]$Value) {
  if ($env:UNCAGE_TEST_USER_PATH_FILE) {
    [IO.File]::WriteAllText($env:UNCAGE_TEST_USER_PATH_FILE, $Value)
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $key.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } finally {
    $key.Close()
  }
  # SetEnvironmentVariable broadcasts WM_SETTINGCHANGE, so new terminals see the new Path.
  try {
    [Environment]::SetEnvironmentVariable('UNCAGE_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('UNCAGE_PATH_REFRESH', $null, 'User')
  } catch { }
}

# Appends $Dir to the user Path once.
function Add-UUserPath([string]$Dir) {
  $cur = Get-UUserPath
  $parts = @($cur -split ';' | Where-Object { $_ -ne '' })
  $want = $Dir.TrimEnd('\')
  foreach ($p in $parts) {
    if ([Environment]::ExpandEnvironmentVariables($p).TrimEnd('\') -ieq $want) { return }
  }
  $parts += $Dir
  Set-UUserPath ($parts -join ';')
  $U.AddedPaths += $Dir
  Say 'path_added' $Dir
}

# The Machine Path comes before the user Path in every new terminal.
function Get-UMachinePath {
  if ($env:UNCAGE_TEST_MACHINE_PATH_FILE) {
    if (-not (Test-UFile $env:UNCAGE_TEST_MACHINE_PATH_FILE)) { return '' }
    return ([string](Get-Content -LiteralPath $env:UNCAGE_TEST_MACHINE_PATH_FILE -Raw)).Trim()
  }
  try { return [string][Environment]::GetEnvironmentVariable('Path', 'Machine') } catch { return '' }
}

# A node.exe in a Machine Path folder other than Node.js 22's own, or ''.
function Find-UMachineNode {
  $mine = (Split-Path -Parent $U.NewNode).TrimEnd('\')
  foreach ($p in ((Get-UMachinePath) -split ';')) {
    if (-not $p) { continue }
    $d = [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\')
    if ($d -ieq $mine) { continue }
    $n = Find-UExe $d 'node'
    if ($n) { return $n }
  }
  return ''
}

# ---- step 1: checks ---------------------------------------------------------------------------

function Test-UPlatform {
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  $U.ArchRaw = [string]$arch
  $U.Arch = ''
  if ($U.ArchRaw -ieq 'AMD64') { $U.Arch = 'x64' } elseif ($U.ArchRaw -ieq 'ARM64') { $U.Arch = 'arm64' }
  $onWindows = ($env:OS -eq 'Windows_NT')
  if (-not $onWindows -or -not $U.Arch) {
    $os = 'Windows'
    if (-not $onWindows) { $os = [string][Environment]::OSVersion.Platform }
    Warn 'os_unsupported' $os $U.ArchRaw
    Stop-Uncage 3
  }
  $U.OwnFnmDir = Join-Path $env:LOCALAPPDATA 'fnm'
  $U.NpmGlobal = Join-Path $env:USERPROFILE '.npm-global'
}

function Get-UNodeVersion([string]$Node) {
  return (Get-USemver (Invoke-UQuery $Node @('--version')))
}

# npm runs as `node npm-cli.js`: npm.cmd would go through cmd.exe, which eats the ^ of a range.
function Invoke-UNpmQuery([string[]]$Argv) {
  return (Get-UFirstLine (Invoke-UQuery $U.Node (@($U.NpmCli) + $Argv)))
}

# Uses node $Node: sets Node, NodeDir, NpmCli, NpmVer, NpmPrefix, NpmWritable, and puts the
# Node.js folder first on this process's PATH (npm and the uncage.cmd shim start `node`).
function Use-UNode([string]$Node) {
  $U.Node = $Node
  $U.NodeDir = Split-Path -Parent $Node
  $env:Path = $U.NodeDir + [IO.Path]::PathSeparator + $U.BasePath
  $U.NpmCli = Join-Path $U.NodeDir 'node_modules\npm\bin\npm-cli.js'
  $U.NpmVer = ''
  $U.NpmPrefix = ''
  $U.NpmWritable = $false
  if (-not (Test-UFile $U.NpmCli)) {
    $U.NpmCli = ''
    return
  }
  $U.NpmVer = Invoke-UNpmQuery @('--version')
  $U.NpmPrefix = Invoke-UNpmQuery @('prefix', '-g')
  if ($U.NpmPrefix -and (Test-UWritable $U.NpmPrefix)) { $U.NpmWritable = $true }
}

# The CLI is always run as uncage.cmd by its full path: under the default Restricted execution
# policy PowerShell refuses npm's PowerShell shim, which it would pick first for a bare `uncage`.
function Find-UCli {
  $U.Uncage = ''
  $U.CliVer = ''
  $c = ''
  if ($U.NpmPrefix) {
    $p = Join-Path $U.NpmPrefix 'uncage.cmd'
    if (Test-UFile $p) { $c = $p }
  }
  if (-not $c) { $c = Find-UCmd 'uncage.cmd' }
  if (-not $c) { return }
  $U.Uncage = $c
  $U.CliVer = Get-USemver (Invoke-UQuery $c @('--version'))
}

function Test-UCliOk {
  return ([bool]$U.Uncage -and [bool]$U.CliVer -and (Test-URange $U.CliVer))
}

function Find-UAgents {
  $U.Claude = Find-UCmd 'claude'
  if (-not $U.Claude) { $U.Claude = Find-UExe (Join-Path $env:USERPROFILE '.local\bin') 'claude' }
  $U.Codex = Find-UCmd 'codex'
}

# Version managers, in order of preference: nvm-windows, fnm, volta.
function Find-UManager {
  $U.Mgr = ''
  $U.MgrLabel = ''
  $U.Fnm = ''
  $U.Volta = ''
  $U.Nvm = Find-UCmd 'nvm'
  if (-not $U.Nvm -and $env:NVM_HOME) { $U.Nvm = Find-UExe $env:NVM_HOME 'nvm' }
  if ($U.Nvm) {
    $U.Mgr = 'nvm'
    $U.MgrLabel = 'nvm-windows'
    return
  }
  $U.Fnm = Find-UCmd 'fnm'
  if (-not $U.Fnm) { $U.Fnm = Find-UExe $U.OwnFnmDir 'fnm' }
  if (-not $U.Fnm) { $U.Fnm = Find-UExe (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links') 'fnm' }
  if ($U.Fnm) {
    $U.Mgr = 'fnm'
    $U.MgrLabel = 'fnm'
    return
  }
  # volta is unmaintained: an existing install is used, never installed by this script.
  $U.Volta = Find-UCmd 'volta'
  if ($U.Volta) {
    $U.Mgr = 'volta'
    $U.MgrLabel = 'volta'
  }
}

function Find-UState {
  $U.BasePath = $env:Path
  $U.PathNode = Find-UCmd 'node'
  $U.PathNodeVer = ''
  $U.NodeOk = $false
  $U.Node = ''
  $U.NodeDir = ''
  $U.NpmCli = ''
  $U.NpmVer = ''
  $U.NpmPrefix = ''
  $U.NpmWritable = $false
  $U.Uncage = ''
  $U.CliVer = ''
  $U.NodeIsDefault = $true
  $U.InstalledNow = $false
  $U.HadDefault = $true
  if ($U.PathNode) {
    $U.PathNodeVer = Get-UNodeVersion $U.PathNode
    if (Test-UNodeMajor $U.PathNodeVer) {
      # Shims (volta, scoop) are not next to npm: use the real node.exe.
      $real = Get-UFirstLine (Invoke-UQuery $U.PathNode @('-p', 'process.execPath'))
      $n = $U.PathNode
      if (Test-UFile $real) { $n = $real }
      Use-UNode $n
      if ($U.NpmCli) { $U.NodeOk = $true }
    }
  }
  if ($U.NodeOk) { Find-UCli }
  Find-UAgents
  Find-UManager
  $U.Winget = Find-UCmd 'winget'
}

function Write-UChecks {
  Say 'checking'
  Say 'os_ok' 'Windows' $U.Arch
  if ($U.NodeOk) {
    Say 'node_ok' $U.PathNodeVer $U.PathNode
    if ($U.NpmWritable) { Say 'npm_ok' $U.NpmVer $U.NpmPrefix } else { Say 'npm_not_writable' $U.NpmVer $U.NpmPrefix }
    if (Test-UCliOk) {
      Say 'cli_ok' $U.CliVer $U.Uncage
    } elseif ($U.Uncage) {
      $v = $U.CliVer
      if (-not $v) { $v = '?' }
      Say 'cli_old' $v $U.CliRange
    } else {
      Say 'cli_missing'
    }
  } else {
    if (-not $U.PathNode -or -not $U.PathNodeVer) {
      Say 'node_missing'
    } elseif (-not (Test-UNodeMajor $U.PathNodeVer)) {
      Say 'node_old' $U.PathNodeVer
    } else {
      Say 'npm_missing'
    }
    Say 'later'
  }
  if ($U.Claude) { Say 'agent_ok' 'Claude Code' $U.Claude } else { Say 'agent_missing' 'Claude Code' }
  if ($U.Codex) { Say 'agent_ok' 'Codex' $U.Codex } else { Say 'agent_missing' 'Codex' }
  Write-Host ''
}

# ---- manual commands (no terminal, or a declined / failed step) -------------------------------

function Get-UFnmZipManualCmds {
  return @(
    ('Invoke-WebRequest -UseBasicParsing ' + $U.FnmZipUrl + ' -OutFile "$env:TEMP\fnm-windows.zip"'),
    'Expand-Archive "$env:TEMP\fnm-windows.zip" "$env:LOCALAPPDATA\fnm" -Force',
    ('& "$env:LOCALAPPDATA\fnm\fnm.exe" install ' + $U.NodeMajor)
  )
}

function Get-UNodeManualCmds {
  $m = [string]$U.NodeMajor
  if ($U.Mgr -eq 'nvm') { return @('nvm install ' + $m) }
  if ($U.Mgr -eq 'fnm') { return @('& ' + (Format-ULiteral $U.Fnm) + ' install ' + $m) }
  if ($U.Mgr -eq 'volta') { return @('volta install node@' + $m) }
  if ($U.Winget) { return @($U.WingetFnm, ('fnm install ' + $m)) }
  return (Get-UFnmZipManualCmds)
}

# npm through cmd.exe would drop the ^ of the range unless it is quoted for cmd.exe as well.
function Get-UNpmInstallCmd([string]$Spec) {
  if ($U.NpmCli) { return ('& ' + (Format-ULiteral $U.Node) + ' ' + (Format-ULiteral $U.NpmCli) + ' install -g ' + (Format-ULiteral $Spec)) }
  return ("cmd /c 'npm install -g " + '"' + $Spec + '"' + "'")
}

# Adds a folder to the user Path by hand without flattening %VARIABLES% in it (the registry value
# is read raw and written back as REG_EXPAND_SZ).
function Get-UPathManualCmd([string]$Dir) {
  return ('$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(''Environment''); $k.SetValue(''Path'', $k.GetValue(''Path'', '''', ''DoNotExpandEnvironmentNames'') + '';' + $Dir + ''', ''ExpandString''); $k.Close()')
}

# No terminal and no -Yes: list what is missing and how to do it by hand; change nothing.
function Assert-UTerminal {
  $need = $false
  if (-not $U.NodeOk) { $need = $true }
  if ($U.NodeOk -and -not $U.NpmWritable) { $need = $true }
  if ($U.NodeOk -and -not (Test-UCliOk)) { $need = $true }
  if (-not $need) { return }
  if ($U.Yes -or $U.Interactive) { return }
  Say 'needs_confirm'
  if (-not $U.NodeOk) {
    Say 'item_node'
    foreach ($c in (Get-UNodeManualCmds)) { Write-UCmd $c }
  }
  if ($U.NodeOk -and -not $U.NpmWritable) {
    Say 'item_npm'
    Write-UCmd 'npm.cmd config set prefix "$env:USERPROFILE\.npm-global"'
    Write-UCmd (Get-UPathManualCmd '%USERPROFILE%\.npm-global')
  }
  if (-not $U.NodeOk -or -not (Test-UCliOk)) {
    Say 'item_cli' $U.CliSpec
    Write-UCmd (Get-UNpmInstallCmd $U.CliSpec)
  }
  Say 'item_setup'
  Write-UCmd ('uncage.cmd setup ' + $U.SiteUrl)
  Say 'rerun_yes'
  Stop-Uncage 2
}

# ---- step 2: Node.js 22 -----------------------------------------------------------------------

function Get-UNvmRoot {
  $out = Invoke-UQuery $U.Nvm @('root')
  if ($out -match 'Current Root:\s*([^\r\n]+)') { return $Matches[1].Trim().TrimEnd('\') }
  if ($env:NVM_HOME) { return $env:NVM_HOME.TrimEnd('\') }
  return ''
}

# fnm keeps its versions and aliases in FNM_DIR, else %USERPROFILE%\.fnm when it exists, else
# %APPDATA%\fnm.
function Get-UFnmDir {
  if ($env:FNM_DIR) { return $env:FNM_DIR }
  $legacy = Join-Path $env:USERPROFILE '.fnm'
  if (Test-UDir $legacy) { return $legacy }
  return (Join-Path $env:APPDATA 'fnm')
}

# fnm makes the first version it installs the default by itself. The alias tells whether a
# default existed before this run.
function Test-UDefaultAlias {
  if ($U.Mgr -ne 'fnm') { return $true }
  return (Test-Path -LiteralPath (Join-Path (Get-UFnmDir) 'aliases\default'))
}

# Call right before installing Node.js with the manager.
function Save-UDefault {
  $U.InstalledNow = $true
  $U.HadDefault = Test-UDefaultAlias
}

# The user kept their default: undo the default fnm created by itself.
function Restore-UDefault {
  if ($U.Mgr -ne 'fnm' -or -not $U.InstalledNow -or $U.HadDefault -or -not (Test-UDefaultAlias)) { return }
  $how = @('unalias', 'default')
  if ($U.PathNode) { $how = @('default', 'system') }
  $line = 'fnm ' + ($how -join ' ')
  Invoke-UNative $U.Fnm $how
  if ($LASTEXITCODE -ne 0) { Stop-UStep $line @($line) }
  Say 'default_restored' 'fnm'
}

# node.exe in the newest <Root>\<Prefix>22.x.y folder, or ''.
function Find-UNewestNode([string]$Root, [string]$Prefix) {
  if (-not (Test-UDir $Root)) { return '' }
  $best = ''
  $bestVer = $null
  foreach ($d in @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue)) {
    if ($d.Name -match ('^' + $Prefix + $U.NodeMajor + '\.(\d+)\.(\d+)$')) {
      $ver = [version]([string]$U.NodeMajor + '.' + $Matches[1] + '.' + $Matches[2])
      if ($null -eq $bestVer -or $ver -gt $bestVer) {
        $bestVer = $ver
        $best = $d.FullName
      }
    }
  }
  if (-not $best) { return '' }
  return (Find-UExe $best 'node')
}

# Sets NewNode / NodeVer to the manager's Node.js 22 without activating it.
function Find-UMgrNode {
  $U.NewNode = ''
  $p = ''
  if ($U.Mgr -eq 'nvm') {
    $p = Find-UNewestNode (Get-UNvmRoot) 'v'
    if ($p) { $U.NvmVersion = Split-Path -Leaf (Split-Path -Parent $p) }
    if ($U.NvmVersion) { $U.NvmVersion = $U.NvmVersion.TrimStart('v') }
  } elseif ($U.Mgr -eq 'fnm') {
    $p = Get-UFirstLine (Invoke-UQuery $U.Fnm @('exec', ('--using=' + $U.NodeMajor), 'node', '-p', 'process.execPath'))
  } elseif ($U.Mgr -eq 'volta') {
    # Not `volta run --node 22`: it would download Node.js before the user said Y.
    $vh = $env:VOLTA_HOME
    if (-not $vh) { $vh = Join-Path $env:LOCALAPPDATA 'Volta' }
    $p = Find-UNewestNode (Join-Path $vh 'tools\image\node') ''
  }
  if (Test-UFile $p) {
    $v = Get-UNodeVersion $p
    if (Test-UNodeMajor $v) {
      $U.NewNode = $p
      $U.NodeVer = $v
      return $true
    }
  }
  return $false
}

function Install-UMgrNode {
  Save-UDefault
  $m = [string]$U.NodeMajor
  # `volta install` would also make it the default: fetch only, `install` after a Y.
  if ($U.Mgr -eq 'nvm') {
    Invoke-UNative $U.Nvm @('install', $m)
  } elseif ($U.Mgr -eq 'fnm') {
    Invoke-UNative $U.Fnm @('install', $m)
  } elseif ($U.Mgr -eq 'volta') {
    Invoke-UNative $U.Volta @('fetch', ('node@' + $m))
  }
  if ($LASTEXITCODE -ne 0) { Stop-UStep ($U.MgrLabel + ' install') (Get-UNodeManualCmds) }
}

function Stop-UNodeDeclined {
  Say 'node_required'
  foreach ($c in (Get-UNodeManualCmds)) { Write-UCmd $c }
  Stop-Uncage 0
}

function Install-UFnmZip {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('uncage-install-' + [Guid]::NewGuid().ToString('N'))
  $ok = $false
  $err = ''
  try {
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp 'fnm-windows.zip'
    if ($env:UNCAGE_TEST_FNM_ZIP) {
      Copy-Item -LiteralPath $env:UNCAGE_TEST_FNM_ZIP -Destination $zip -ErrorAction Stop
    } else {
      # Windows PowerShell 5.1 may not offer TLS 1.2 by default.
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri $U.FnmZipUrl -OutFile $zip -ErrorAction Stop
    }
    New-Item -ItemType Directory -Path $U.OwnFnmDir -Force | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $U.OwnFnmDir -Force -ErrorAction Stop
    $ok = $true
  } catch {
    $err = [string]$_
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not $ok) {
    if ($err) { Write-UErr $err }
    Stop-UStep ('download ' + $U.FnmZipUrl) (Get-UFnmZipManualCmds)
  }
}

function Find-UWingetFnm {
  $fnm = Find-UExe (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links') 'fnm'
  if ($fnm) { return $fnm }
  $pkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (-not (Test-UDir $pkgs)) { return '' }
  foreach ($d in @(Get-ChildItem -LiteralPath $pkgs -Directory -Filter 'Schniz.fnm*' -ErrorAction SilentlyContinue)) {
    $fnm = Find-UExe $d.FullName 'fnm'
    if ($fnm) { return $fnm }
  }
  return ''
}

# No version manager: fnm per user (winget's portable package, else the release zip). Never a
# Node.js MSI: those are machine-wide and need admin rights (UAC).
function Install-UOwnFnm {
  $fnm = ''
  if ($U.Winget) {
    if (-not (Ask 'ask_node_winget')) { Stop-UNodeDeclined }
    Invoke-UNative $U.Winget @('install', '--id', 'Schniz.fnm', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements')
    $fnm = Find-UWingetFnm
    if (-not $fnm) { Stop-UStep 'winget install Schniz.fnm' (Get-UNodeManualCmds) }
  } else {
    if (-not (Ask 'ask_node_fnm' $U.OwnFnmDir)) { Stop-UNodeDeclined }
    Install-UFnmZip
    $fnm = Find-UExe $U.OwnFnmDir 'fnm'
    if (-not $fnm) { Stop-UStep ('download ' + $U.FnmZipUrl) (Get-UFnmZipManualCmds) }
    Add-UUserPath $U.OwnFnmDir
  }
  $U.Mgr = 'fnm'
  $U.MgrLabel = 'fnm'
  $U.Fnm = $fnm
  Save-UDefault
  Invoke-UNative $U.Fnm @('install', [string]$U.NodeMajor)
  if ($LASTEXITCODE -ne 0) { Stop-UStep ('fnm install ' + $U.NodeMajor) @('& ' + (Format-ULiteral $fnm) + ' install ' + $U.NodeMajor) }
}

function Set-UMgrDefault {
  $m = [string]$U.NodeMajor
  if ($U.Mgr -eq 'fnm') {
    Invoke-UNative $U.Fnm @('default', $m)
    if ($LASTEXITCODE -ne 0) { Stop-UStep 'fnm default' @('fnm default ' + $m) }
    Add-UUserPath (Join-Path (Get-UFnmDir) 'aliases\default')
  } elseif ($U.Mgr -eq 'volta') {
    Invoke-UNative $U.Volta @('install', ('node@' + $m))
    if ($LASTEXITCODE -ne 0) { Stop-UStep 'volta install' @('volta install node@' + $m) }
  }
}

# Changing the default needs its own Y. Under -Yes only when there was no Node.js at all.
function Set-UDefaultNode {
  if ($U.Mgr -eq 'nvm') {
    # `nvm use` makes a symlink, which needs admin rights: never run here.
    $U.NodeIsDefault = $false
    Say 'nvm_use_hint' $U.NvmVersion
    return
  }
  $make = $true
  if ($U.Yes -and $U.PathNode) {
    $make = $false
    Say 'default_kept_yes'
  } elseif (-not (Ask 'ask_default')) {
    $make = $false
  }
  if ($make) {
    Set-UMgrDefault
    $other = Find-UMachineNode
    if ($other) {
      # The Machine Path comes first, so new terminals would still start that Node.js.
      $U.NodeIsDefault = $false
      Warn 'default_shadowed' $other
    } else {
      Say 'default_done'
    }
  } else {
    $U.NodeIsDefault = $false
    Restore-UDefault
    Say 'default_kept' $U.NewNode
  }
}

function Invoke-UNodeStep {
  if ($U.NodeOk) { return }
  $U.NewNode = ''
  if ($U.Mgr) {
    if (Find-UMgrNode) {
      Say 'node_found_mgr' $U.MgrLabel $U.NewNode
    } else {
      if (-not (Ask 'ask_node_mgr' $U.MgrLabel)) { Stop-UNodeDeclined }
      Install-UMgrNode
      if (-not (Find-UMgrNode)) { Stop-UStep ($U.MgrLabel + ' install') (Get-UNodeManualCmds) }
      Say 'node_installed' $U.NodeVer $U.NewNode
    }
  } else {
    Install-UOwnFnm
    if (-not (Find-UMgrNode)) { Stop-UStep ('fnm install ' + $U.NodeMajor) (Get-UNodeManualCmds) }
    Say 'node_installed' $U.NodeVer $U.NewNode
  }
  Set-UDefaultNode
  Use-UNode $U.NewNode
  if (-not $U.NpmCli) { Stop-UStep 'npm' (Get-UNodeManualCmds) }
  $U.NodeOk = $true
  Find-UCli
}

# ---- step 3: npm global folder ----------------------------------------------------------------

function Invoke-UNpmPrefixStep {
  if ($U.NpmWritable) { return }
  if (-not (Ask 'ask_npm_prefix' $U.NpmPrefix $U.NpmGlobal)) {
    Say 'declined'
    Write-UCmd 'npm.cmd config set prefix "$env:USERPROFILE\.npm-global"'
    Write-UCmd (Get-UPathManualCmd '%USERPROFILE%\.npm-global')
    Write-UCmd (Get-UNpmInstallCmd $U.CliSpec)
    Stop-Uncage 0
  }
  New-Item -ItemType Directory -Path $U.NpmGlobal -Force | Out-Null
  Invoke-UNative $U.Node @($U.NpmCli, 'config', 'set', 'prefix', $U.NpmGlobal)
  if ($LASTEXITCODE -ne 0) { Stop-UStep 'npm config set prefix' @('npm.cmd config set prefix "$env:USERPROFILE\.npm-global"') }
  $U.NpmPrefix = $U.NpmGlobal
  $U.NpmWritable = $true
  Say 'npm_prefix_done' $U.NpmGlobal
  Add-UUserPath $U.NpmGlobal
  Find-UCli
}

# ---- step 4: the Uncage CLI -------------------------------------------------------------------

function Invoke-UCliStep {
  $spec = $U.CliSpec
  if ($env:UNCAGE_CLI_SPEC) { $spec = $env:UNCAGE_CLI_SPEC }
  if (Test-UCliOk) {
    Say 'cli_skip' $U.CliVer $U.Uncage
    return
  }
  $manual = Get-UNpmInstallCmd $spec
  if (-not (Ask 'ask_cli' $spec)) {
    Say 'declined'
    Write-UCmd $manual
    Stop-Uncage 0
  }
  Invoke-UNative $U.Node @($U.NpmCli, 'install', '-g', $spec)
  if ($LASTEXITCODE -ne 0) { Stop-UStep ('npm install -g ' + $spec) @($manual) }
  $U.Uncage = ''
  $p = Join-Path $U.NpmPrefix 'uncage.cmd'
  if (Test-UFile $p) { $U.Uncage = $p } else { $U.Uncage = Find-UCmd 'uncage.cmd' }
  if (-not $U.Uncage) { Stop-UStep ('npm install -g ' + $spec) @($manual) }
  Say 'cli_installed' $U.Uncage
}

# ---- the site's own step (HubOptions.installScript.ps1AfterCli) --------------------------------

# Runs in its own PowerShell process (so leaving it early never closes this window), with Node.js 22
# first on PATH and UNCAGE_BIN, UNCAGE_NODE, UNCAGE_SITE_URL set. A non-zero result fails the run.
function Invoke-UExtension {
  if (-not $UncageExt) { return }
  Say 'extension_running'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('uncage-install-' + [Guid]::NewGuid().ToString('N'))
  $saved = @($env:UNCAGE_BIN, $env:UNCAGE_NODE, $env:UNCAGE_SITE_URL)
  $code = 1
  try {
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $file = Join-Path $tmp 'extension.ps1'
    [IO.File]::WriteAllText($file, $UncageExt)
    $env:UNCAGE_BIN = $U.Uncage
    $env:UNCAGE_NODE = $U.Node
    $env:UNCAGE_SITE_URL = $U.SiteUrl
    $shell = (Get-Process -Id $PID).Path
    Invoke-UNative $shell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $file)
    $code = $LASTEXITCODE
  } catch {
    Write-UErr ([string]$_)
    $code = 1
  } finally {
    $env:UNCAGE_BIN = $saved[0]
    $env:UNCAGE_NODE = $saved[1]
    $env:UNCAGE_SITE_URL = $saved[2]
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) { Stop-UStep (Get-UMsg 'extension_step') @() }
}

# ---- step 5: agents, then step 6: setup -------------------------------------------------------

# ACP agents count too, once the CLI knows them (`uncage runtimes --json`, when it exists).
function Test-UAcp {
  $out = Invoke-UQuery $U.Uncage @('runtimes', '--json')
  return ($out -match '"status"\s*:\s*"available"')
}

function Write-UWhere {
  if ($U.NodeIsDefault) {
    Say 'uncage_path' (Format-ULiteral $U.Uncage)
  } else {
    Say 'not_default_hint' (Format-ULiteral ($U.NodeDir + ';')) (Format-ULiteral $U.Uncage)
  }
}

function Invoke-USetupStep {
  if (-not $U.Claude -and -not $U.Codex -and -not (Test-UAcp)) {
    Write-Host ''
    Say 'no_agent'
    Write-UWhere
    Stop-Uncage 0
  }
  $setup = '& ' + (Format-ULiteral $U.Uncage) + ' setup ' + $U.SiteUrl
  if (-not $U.NodeIsDefault) { $setup = '$env:Path = ' + (Format-ULiteral ($U.NodeDir + ';')) + ' + $env:Path; ' + $setup }
  $later = $U.NoSetup -or (-not $U.Yes -and -not $U.Interactive)
  if ($later -or -not (Ask 'ask_setup' $U.SiteUrl)) {
    Write-UWhere
    Say 'setup_later' $setup
    Stop-Uncage 0
  }
  Invoke-UNative $U.Uncage @('setup', $U.SiteUrl)
  if ($LASTEXITCODE -ne 0) { Stop-UStep 'uncage setup' @($setup) }
  Write-UWhere
  Say 'done'
}

function Invoke-UncageSteps {
  Test-UPlatform
  Find-UState
  Write-UChecks
  Assert-UTerminal
  Invoke-UNodeStep
  Invoke-UNpmPrefixStep
  Invoke-UCliStep
  Invoke-UExtension
  Invoke-USetupStep
}

function Invoke-UncageMain {
  $U.Code = 0
  $U.AddedPaths = @()
  $prevPath = $env:Path
  $prevEnc = $null
  try {
    $prevEnc = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  } catch {
    $prevEnc = $null
  }
  try {
    Set-UncageConfig
    Read-UOptions
    Initialize-UInput
    Invoke-UncageSteps
  } catch {
    if ([string]$_ -ne 'UNCAGE_STOP') {
      Write-UErr ('uncage: ' + [string]$_)
      Write-UErr ([string]$_.InvocationInfo.PositionMessage)
      $U.Code = 1
    }
  } finally {
    # This window keeps its Path, plus the folders just added to the user Path.
    $env:Path = $prevPath
    foreach ($d in $U.AddedPaths) {
      if (-not (@($env:Path -split ';') -contains $d)) { $env:Path = $env:Path + ';' + $d }
    }
    if ($null -ne $prevEnc) {
      try { [Console]::OutputEncoding = $prevEnc } catch { }
    }
  }
  $uncageState.Code = $U.Code
}

Invoke-UncageMain
} ([bool]$Yes) ([bool]$NoSetup) ([string]$Lang)

# Under `irm | iex` this runs in the caller's session: leave only $LASTEXITCODE behind.
if ($PSCommandPath) { exit $uncageState.Code } else { $global:LASTEXITCODE = $uncageState.Code; Remove-Variable -Name uncageState, Yes, NoSetup, Lang -ErrorAction SilentlyContinue }
