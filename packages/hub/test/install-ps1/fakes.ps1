# Sandbox for install.ps1 scenario tests (dot-sourced by run.ps1). Plain PowerShell, no Pester;
# runs under Windows PowerShell 5.1 and PowerShell 7 on Windows.
#
# New-UncageSandbox makes a throwaway folder (with spaces in its name) holding a fake user profile
# (USERPROFILE, APPDATA, LOCALAPPDATA, TEMP all point inside it), a `bin` folder that is the only
# non-system entry on PATH, and fake programs written as .cmd files: node (also acting as npm when
# its first argument is npm-cli.js), nvm, fnm, volta, winget, claude, codex and the uncage.cmd that
# the fake `npm install -g` drops into the npm prefix. Every fake appends "<name> <args>" to
# calls.log. The user Path is a file (UNCAGE_TEST_USER_PATH_FILE), never the registry. Nothing
# here touches the real profile, the registry or the network.

$ErrorActionPreference = 'Stop'

function Write-FakeFile([string]$Path, [string[]]$Lines) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Path, (($Lines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)
}

# Creates a Node.js folder: node.cmd, .node-version and node_modules\npm\bin\npm-cli.js.
$FakeMkNode = @(
  '@echo off',
  'if not exist "%~1\node_modules\npm\bin" mkdir "%~1\node_modules\npm\bin"',
  'copy /y "%UNCAGE_FAKE_DIR%\node.cmd" "%~1\node.cmd" >nul',
  '>"%~1\.node-version" echo %~2',
  '>"%~1\node_modules\npm\bin\npm-cli.js" echo // fake npm',
  'exit /b 0'
)

$FakeNode = @(
  '@echo off',
  'setlocal',
  'set "NV="',
  'set /p NV=<"%~dp0.node-version"',
  'if /i "%~nx1"=="npm-cli.js" goto npm',
  '>>"%UNCAGE_FAKE_LOG%" echo node %*',
  'if "%~1"=="--version" goto version',
  'if "%~1"=="-p" goto execpath',
  'exit /b 0',
  ':version',
  'echo v%NV%',
  'exit /b 0',
  ':execpath',
  'echo %~f0',
  'exit /b 0',
  ':npm',
  '>>"%UNCAGE_FAKE_LOG%" echo npm %2 %3 %4 %5 @ %~dp0',
  'call :prefix',
  'if "%~2"=="--version" goto npmversion',
  'if "%~2"=="prefix" goto npmprefix',
  'if "%~2"=="config" goto npmconfig',
  'if "%~2"=="install" goto npminstall',
  'exit /b 0',
  ':npmversion',
  'echo 10.9.2',
  'exit /b 0',
  ':npmprefix',
  'echo %P%',
  'exit /b 0',
  ':npmconfig',
  '>"%USERPROFILE%\.npmrc" echo prefix=%~5',
  'exit /b 0',
  ':npminstall',
  'if exist "%UNCAGE_FAKE_DIR%\npm-fails" exit /b 1',
  'if not exist "%P%" mkdir "%P%"',
  'copy /y "%UNCAGE_FAKE_DIR%\uncage.cmd" "%P%\uncage.cmd" >nul',
  'copy /y "%UNCAGE_FAKE_DIR%\uncage-shim.ps1" "%P%\uncage.ps1" >nul',
  '>"%P%\.uncage-version" echo 0.3.0',
  'exit /b 0',
  ':prefix',
  'set "P=%~dp0"',
  'set "P=%P:~0,-1%"',
  'if exist "%~dp0.npm-prefix" set /p P=<"%~dp0.npm-prefix"',
  'if exist "%USERPROFILE%\.npmrc" for /f "usebackq tokens=1,* delims==" %%a in ("%USERPROFILE%\.npmrc") do if "%%a"=="prefix" set "P=%%b"',
  'exit /b 0'
)

$FakeUncage = @(
  '@echo off',
  '>>"%UNCAGE_FAKE_LOG%" echo uncage %*',
  'if "%~1"=="--version" goto version',
  'if "%~1"=="runtimes" goto runtimes',
  'if "%~1"=="setup" goto setup',
  'exit /b 0',
  ':version',
  'type "%~dp0.uncage-version"',
  'exit /b 0',
  ':runtimes',
  'if not exist "%UNCAGE_FAKE_DIR%\acp" exit /b 1',
  'echo {"runtimes":[{"id":"gemini","status": "available"}]}',
  'exit /b 0',
  ':setup',
  'if exist "%UNCAGE_FAKE_DIR%\setup-fails" exit /b 1',
  'exit /b 0'
)

# npm's PowerShell shim; PowerShell picks it over uncage.cmd for a bare `uncage`.
$FakeUncageShim = @("Write-Output 'SHIM-RAN'")

$FakeNvm = @(
  '@echo off',
  'setlocal',
  '>>"%UNCAGE_FAKE_LOG%" echo nvm %*',
  'if "%~1"=="root" goto root',
  'if "%~1"=="install" goto install',
  'exit /b 0',
  ':root',
  'echo.',
  'echo Current Root: %~dp0',
  'exit /b 0',
  ':install',
  'call "%UNCAGE_FAKE_DIR%\mknode.cmd" "%~dp0v22.23.4" 22.23.4',
  'echo Installation complete.',
  'exit /b 0'
)

# fnm keeps versions in FNM_DIR, else %USERPROFILE%\.fnm when it exists, else %APPDATA%\fnm, and
# makes the first version it installs the default.
$FakeFnm = @(
  '@echo off',
  'setlocal',
  '>>"%UNCAGE_FAKE_LOG%" echo fnm %*',
  'set "D=%APPDATA%\fnm"',
  'if exist "%USERPROFILE%\.fnm" set "D=%USERPROFILE%\.fnm"',
  'if defined FNM_DIR set "D=%FNM_DIR%"',
  'set "N=%D%\node-versions\v22.23.4\installation"',
  'if "%~1"=="--version" goto version',
  'if "%~1"=="install" goto install',
  'if "%~1"=="exec" goto exec',
  'if "%~1"=="default" goto default',
  'if "%~1"=="unalias" goto unalias',
  'exit /b 0',
  ':version',
  'echo fnm 1.39.0',
  'exit /b 0',
  ':install',
  'call "%UNCAGE_FAKE_DIR%\mknode.cmd" "%N%" 22.23.4',
  'if not exist "%D%\aliases\default" mkdir "%D%\aliases\default"',
  'exit /b 0',
  ':exec',
  'if not exist "%N%\node.cmd" exit /b 1',
  'echo %N%\node.cmd',
  'exit /b 0',
  ':default',
  'if not exist "%D%\aliases\default" mkdir "%D%\aliases\default"',
  '>"%D%\aliases\default\.alias" echo %~2',
  'exit /b 0',
  ':unalias',
  'if exist "%D%\aliases\default" rmdir /s /q "%D%\aliases\default"',
  'exit /b 0'
)

$FakeVolta = @(
  '@echo off',
  'setlocal',
  '>>"%UNCAGE_FAKE_LOG%" echo volta %*',
  'set "N=%LOCALAPPDATA%\Volta\tools\image\node\22.23.4"',
  'if "%~1"=="fetch" goto fetch',
  'if "%~1"=="run" goto run',
  'exit /b 0',
  ':fetch',
  'call "%UNCAGE_FAKE_DIR%\mknode.cmd" "%N%" 22.23.4',
  'exit /b 0',
  ':run',
  'if not exist "%N%\node.cmd" exit /b 1',
  'echo %N%\node.cmd',
  'exit /b 0'
)

# winget's portable fnm package lands in %LOCALAPPDATA%\Microsoft\WinGet\Links.
$FakeWinget = @(
  '@echo off',
  'setlocal',
  '>>"%UNCAGE_FAKE_LOG%" echo winget %*',
  'if not "%~1"=="install" exit /b 0',
  'set "L=%LOCALAPPDATA%\Microsoft\WinGet\Links"',
  'if not exist "%L%" mkdir "%L%"',
  'copy /y "%UNCAGE_FAKE_DIR%\fnm.cmd" "%L%\fnm.cmd" >nul',
  'echo Successfully installed',
  'exit /b 0'
)

function New-FakeAgent([string]$Name) {
  return @('@echo off', ('>>"%UNCAGE_FAKE_LOG%" echo ' + $Name + ' %*'), 'exit /b 0')
}

$UncageSandboxEnv = @('NVM_HOME', 'NVM_SYMLINK', 'FNM_DIR', 'FNM_MULTISHELL_PATH', 'VOLTA_HOME', 'npm_config_prefix',
  'UNCAGE_YES', 'UNCAGE_NO_SETUP', 'UNCAGE_LANG', 'UNCAGE_ANSWERS', 'UNCAGE_CLI_SPEC', 'UNCAGE_TEST_FNM_ZIP')

function New-UncageSandbox {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('uncage ps1 ' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $sb = @{
    Root = $root
    Home = (Join-Path $root 'home dir')
    Bin = (Join-Path $root 'bin')
    Fakes = (Join-Path $root 'fakes')
    Log = (Join-Path $root 'calls.log')
    UserPath = (Join-Path $root 'userpath.txt')
    Tmp = (Join-Path $root 'tmp')
  }
  $sb.Local = Join-Path $sb.Home 'AppData\Local'
  $sb.Roaming = Join-Path $sb.Home 'AppData\Roaming'
  foreach ($d in @($sb.Home, $sb.Bin, $sb.Fakes, $sb.Local, $sb.Roaming, $sb.Tmp)) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }
  Write-FakeFile (Join-Path $sb.Fakes 'mknode.cmd') $FakeMkNode
  Write-FakeFile (Join-Path $sb.Fakes 'node.cmd') $FakeNode
  Write-FakeFile (Join-Path $sb.Fakes 'uncage.cmd') $FakeUncage
  Write-FakeFile (Join-Path $sb.Fakes 'uncage-shim.ps1') $FakeUncageShim
  Write-FakeFile (Join-Path $sb.Fakes 'nvm.cmd') $FakeNvm
  Write-FakeFile (Join-Path $sb.Fakes 'fnm.cmd') $FakeFnm
  Write-FakeFile (Join-Path $sb.Fakes 'volta.cmd') $FakeVolta
  Write-FakeFile (Join-Path $sb.Fakes 'winget.cmd') $FakeWinget
  [IO.File]::WriteAllText($sb.UserPath, 'C:\Existing\Tools')

  foreach ($n in $UncageSandboxEnv) { Remove-Item -Path ('Env:' + $n) -ErrorAction SilentlyContinue }
  $env:USERPROFILE = $sb.Home
  $env:HOME = $sb.Home
  $env:LOCALAPPDATA = $sb.Local
  $env:APPDATA = $sb.Roaming
  $env:TEMP = $sb.Tmp
  $env:TMP = $sb.Tmp
  $env:UNCAGE_FAKE_LOG = $sb.Log
  $env:UNCAGE_FAKE_DIR = $sb.Fakes
  $env:UNCAGE_TEST_USER_PATH_FILE = $sb.UserPath
  $env:CI = 'true'
  $sys = $env:SystemRoot
  $sb.SysPath = "$sys\System32;$sys;$sys\System32\WindowsPowerShell\v1.0"
  $env:PATH = $sb.Bin + ';' + $sb.SysPath
  return $sb
}

function Remove-UncageSandbox($Sb) {
  Remove-Item -LiteralPath $Sb.Root -Recurse -Force -ErrorAction SilentlyContinue
}

# Node.js $Version in $Dir (default: bin, i.e. on PATH).
function Add-FakeNode($Sb, [string]$Version = '22.23.4', [string]$Dir = '') {
  if (-not $Dir) { $Dir = $Sb.Bin }
  New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'node_modules\npm\bin') | Out-Null
  Copy-Item -LiteralPath (Join-Path $Sb.Fakes 'node.cmd') -Destination (Join-Path $Dir 'node.cmd')
  [IO.File]::WriteAllText((Join-Path $Dir '.node-version'), $Version)
  [IO.File]::WriteAllText((Join-Path $Dir 'node_modules\npm\bin\npm-cli.js'), '// fake npm')
}

function Add-FakeTool($Sb, [string]$Name) {
  Copy-Item -LiteralPath (Join-Path $Sb.Fakes ($Name + '.cmd')) -Destination (Join-Path $Sb.Bin ($Name + '.cmd'))
}

function Add-FakeAgent($Sb, [string]$Name) {
  Write-FakeFile (Join-Path $Sb.Bin ($Name + '.cmd')) (New-FakeAgent $Name)
}

# nvm-windows in %LOCALAPPDATA%\nvm (NVM_HOME, on PATH).
function Add-FakeNvm($Sb) {
  $nvmHome = Join-Path $Sb.Local 'nvm'
  New-Item -ItemType Directory -Force -Path $nvmHome | Out-Null
  Copy-Item -LiteralPath (Join-Path $Sb.Fakes 'nvm.cmd') -Destination (Join-Path $nvmHome 'nvm.cmd')
  $env:NVM_HOME = $nvmHome
  $env:PATH = $nvmHome + ';' + $env:PATH
  return $nvmHome
}

# A local stand-in for fnm-windows.zip (UNCAGE_TEST_FNM_ZIP).
function Add-FakeFnmZip($Sb) {
  $zip = Join-Path $Sb.Root 'fnm-windows.zip'
  Compress-Archive -LiteralPath (Join-Path $Sb.Fakes 'fnm.cmd') -DestinationPath $zip -Force
  $env:UNCAGE_TEST_FNM_ZIP = $zip
  return $zip
}

function Get-Calls($Sb) {
  if (-not (Test-Path -LiteralPath $Sb.Log)) { return @() }
  return @(Get-Content -LiteralPath $Sb.Log | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Clear-Calls($Sb) {
  Remove-Item -LiteralPath $Sb.Log -Force -ErrorAction SilentlyContinue
}

function Get-UserPathEntries($Sb) {
  return @(([string](Get-Content -LiteralPath $Sb.UserPath -Raw)).Trim() -split ';' | Where-Object { $_ -ne '' })
}

# Runs the installer in a new process of this same PowerShell.
#   -Mode file:        powershell -File install.ps1 <args>   (result = process exit code)
#   -Mode iex:         Get-Content -Raw install.ps1 | Invoke-Expression, like `irm | iex`
#   -Mode scriptblock: & ([scriptblock]::Create(<script>)) <args>
# iex / scriptblock print "AFTER <LASTEXITCODE>" afterwards: the window was not closed.
function Invoke-Installer {
  param($Sb, [string]$Script, [string]$Answers = '', [string[]]$Arguments = @(), [string]$Mode = 'file')
  if ($Answers) { $env:UNCAGE_ANSWERS = $Answers } else { Remove-Item -Path Env:UNCAGE_ANSWERS -ErrorAction SilentlyContinue }
  $exe = (Get-Process -Id $PID).Path
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Mode -eq 'file') {
      $lines = & $exe -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1
    } elseif ($Mode -eq 'iex') {
      $cmd = "Get-Content -Raw -LiteralPath '" + $Script + "' | Invoke-Expression; Write-Output ('AFTER ' + `$LASTEXITCODE)"
      $lines = & $exe -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1
    } else {
      $cmd = "& ([scriptblock]::Create((Get-Content -Raw -LiteralPath '" + $Script + "'))) " + ($Arguments -join ' ') + "; Write-Output ('AFTER ' + `$LASTEXITCODE)"
      $lines = & $exe -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  $out = (@($lines) | ForEach-Object { [string]$_ }) -join "`n"
  return @{ Code = $code; Out = $out }
}
