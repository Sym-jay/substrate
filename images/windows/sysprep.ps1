# The image build's last step: EC2Launch generalizes Windows (sysprep) and
# shuts the builder down, ready to be saved as an image. sshd hasn't run, so
# there are no host keys to remove; this makes sure.
Stop-Service sshd -ErrorAction SilentlyContinue
Remove-Item 'C:\ProgramData\ssh\ssh_host_*' -Force -ErrorAction SilentlyContinue
& "$env:ProgramFiles\Amazon\EC2Launch\EC2Launch.exe" sysprep --clean=true --shutdown=true
