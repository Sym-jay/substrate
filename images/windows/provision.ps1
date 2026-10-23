# What the Windows workspace image has. scripts/build-windows-image.ts runs
# this on a builder through SSM (Windows PowerShell, as SYSTEM). Things a
# workspace needs its own of (passwords, SSH keys, TightVNC's password) are
# set at its first boot instead: see apps/control/src/windows/user-data.ts.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$dir = 'C:\substrate'
New-Item -ItemType Directory -Force $dir | Out-Null
function Step($name) { Write-Output "[provision] $(Get-Date -Format HH:mm:ss) $name" }
function Download($url, $file) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }
function Install($file, $arguments) {
  $p = Start-Process -FilePath $file -ArgumentList $arguments -Wait -PassThru -NoNewWindow
  if ($p.ExitCode -notin 0, 3010) { throw "$file exited with $($p.ExitCode)" }
}
function LatestAsset($repo, $pattern) {
  $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'substrate' }
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { throw "no release of $repo has a file matching $pattern" }
  $asset.browser_download_url
}

Step 'Git for Windows (Claude Code uses its Bash)'
Download (LatestAsset 'git-for-windows/git' '^Git-[\d.]+-64-bit\.exe$') "$dir\git.exe"
Install "$dir\git.exe" '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES'

Step 'Node.js LTS'
$node = (Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1).version
Download "https://nodejs.org/dist/$node/node-$node-x64.msi" "$dir\node.msi"
Install 'msiexec.exe' "/i $dir\node.msi /qn /norestart"

Step 'PowerShell 7 (the SSH shell)'
Download (LatestAsset 'PowerShell/PowerShell' '^PowerShell-[\d.]+-win-x64\.msi$') "$dir\pwsh.msi"
Install 'msiexec.exe' "/i $dir\pwsh.msi /qn /norestart ADD_PATH=1 REGISTER_MANIFEST=1"

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')

# In Node's own folder, which is on everyone's PATH, rather than SYSTEM's profile.
Step 'Claude Code and Codex'
& npm.cmd install --global --prefix "$env:ProgramFiles\nodejs" '@anthropic-ai/claude-code' '@openai/codex'
if ($LASTEXITCODE) { throw "npm install exited with $LASTEXITCODE" }

# Built into Windows Server 2025. It's first started at a workspace's first
# boot, so each makes its own host keys.
Step 'OpenSSH server'
$ssh = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
if ($ssh.State -ne 'Installed') { Add-WindowsCapability -Online -Name $ssh.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:ProgramFiles\PowerShell\7\pwsh.exe" -PropertyType String -Force | Out-Null
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
}

# Kept here and installed at first boot, with the workspace's own password.
Step 'TightVNC installer'
$page = Invoke-WebRequest -UseBasicParsing -Uri 'https://www.tightvnc.com/download.php'
$href = [regex]::Match($page.Content, '[^"''\s>]*tightvnc-[\d.]+-gpl-setup-64bit\.msi').Value
if (-not $href) { throw "couldn't find TightVNC's installer" }
Download ([Uri]::new([Uri]'https://www.tightvnc.com/', $href).AbsoluteUri) "$dir\tightvnc.msi"
if (-not (Get-NetFirewallRule -Name 'Substrate-VNC' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'Substrate-VNC' -DisplayName 'VNC (desktop, from the control box)' -Direction Inbound -Protocol TCP -LocalPort 5900 -Action Allow | Out-Null
}

# Takes effect after the restart that follows; `wsl --install -d Ubuntu` then works.
Step 'WSL'
Enable-WindowsOptionalFeature -Online -FeatureName 'Microsoft-Windows-Subsystem-Linux' -All -NoRestart | Out-Null
Enable-WindowsOptionalFeature -Online -FeatureName 'VirtualMachinePlatform' -All -NoRestart | Out-Null

Step 'Desktop'
Get-ScheduledTask -TaskName 'ServerManager' -ErrorAction SilentlyContinue | Disable-ScheduledTask | Out-Null

Remove-Item "$dir\git.exe", "$dir\node.msi", "$dir\pwsh.msi" -Force
Step 'Installed'
& git.exe --version
& node.exe --version
& "$env:ProgramFiles\PowerShell\7\pwsh.exe" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
& claude.cmd --version
& codex.cmd --version
