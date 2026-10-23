// A new Windows workspace's first boot (EC2Launch runs it once, as SYSTEM, in
// Windows PowerShell). It gives the workspace its own passwords, trusts the
// control box's SSH key and nothing else, and installs TightVNC.
export function windowsUserData({ password, vncPassword, publicKey }: { password: string; vncPassword: string; publicKey: string }) {
  for (const [key, value] of Object.entries({ password, vncPassword, publicKey })) {
    if (!/^[A-Za-z0-9 +/=@._-]+$/.test(value)) throw new Error(`${key} has characters PowerShell can't take as is`)
  }
  return `<powershell>
$ErrorActionPreference = 'Stop'
Start-Transcript -Path 'C:\\substrate\\first-boot.log' -Append | Out-Null

# Administrator's password, for the desktop. From the next start on, Windows
# signs in by itself, so the desktop opens straight away.
# (Not net.exe, which stops to ask about passwords over 14 characters.)
Set-LocalUser -Name Administrator -Password (ConvertTo-SecureString '${password}' -AsPlainText -Force)
$winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value '1'
Set-ItemProperty -Path $winlogon -Name DefaultUserName -Value 'Administrator'
Set-ItemProperty -Path $winlogon -Name DefaultPassword -Value '${password}'

# SSH: the control box's key only. Its first start makes this workspace's own
# host keys and config. Windows' own firewall rule for it covers private
# networks only, and EC2's count as public.
Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Profile Any -Enabled True
Start-Service sshd
$keys = 'C:\\ProgramData\\ssh\\administrators_authorized_keys'
Set-Content -Path $keys -Value '${publicKey}' -Encoding ascii
icacls.exe $keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
$config = 'C:\\ProgramData\\ssh\\sshd_config'
(Get-Content $config) -replace '^#?\\s*PasswordAuthentication\\s.*$', 'PasswordAuthentication no' | Set-Content $config -Encoding ascii
Restart-Service sshd

# TightVNC for the desktop, with this workspace's password, and without its
# web viewer.
$vnc = Start-Process msiexec.exe -Wait -PassThru -ArgumentList ('/i C:\\substrate\\tightvnc.msi /quiet /norestart ADDLOCAL=Server ' +
  'SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=${vncPassword} ' +
  'SET_USECONTROLAUTHENTICATION=1 VALUE_OF_USECONTROLAUTHENTICATION=1 SET_CONTROLPASSWORD=1 VALUE_OF_CONTROLPASSWORD=${vncPassword} ' +
  'SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=0')
if ($vnc.ExitCode -ne 0) { throw "TightVNC's installer exited with $($vnc.ExitCode)" }

New-Item -ItemType File -Force -Path 'C:\\substrate\\ready' | Out-Null
</powershell>
`
}
