# telepy-remove-tunnel: run by Telepy over SSH when a tunnel is deleted (Windows).
# Same contract as remove_tunnel.sh: find what runs THIS tunnel (matched by its reverse port or key;
# nothing else is touched), remove its files now and write the stopping part into a one-shot stop
# script that Telepy starts last. Every result is a line "TELEPY|<kind>|<what>|<detail>".
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$TunnelId = ${t_id}
$TunnelPort = ${t_port}
$TunnelKey = ${t_key}

function Out-Telepy([string]$Kind, [string]$What, [string]$Detail) {
    Write-Output ('TELEPY|{0}|{1}|{2}' -f $Kind, $What, ($Detail -replace '[\r\n]+', ' '))
}
$Hosts = '(localhost|127\.0\.0\.1|\[::1\]|::1):[0-9]+'
# 檔案裡的 forward；命令列上的 -R forward（不碰同號碼的 -L）。/ The forward in files; a -R forward on a command line.
$PortRe = '(^|[^0-9])' + $TunnelPort + ':' + $Hosts
$ProcRe = '-[A-Za-z]*R ?[''"]?([^ :''"]*:)?' + $TunnelPort + ':' + $Hosts
$EnvRe = 'SSH_TUNNEL_PORT[=:][" ]*' + $TunnelPort + '([^0-9]|$)'
$ScriptRe = '[A-Za-z]:\\[^"*?<>|]*?\.(ps1|bat|cmd|vbs)'

function Test-Port([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $text = [string](Get-Content -LiteralPath $Path -Raw)
    return ($text -match $PortRe) -or ($text -match $EnvRe)
}
# 命令列帶這條 forward，或指到含這條 forward 的腳本。/ A command line with the forward or pointing at a script with it.
function Test-Command([string]$Text) {
    if (-not $Text) { return $false }
    if ($Text -match $ProcRe) { return $true }
    foreach ($m in [regex]::Matches($Text, $ScriptRe)) { if (Test-Port $m.Value) { return $true } }
    return $false
}
function Quote([string]$Value) { "'" + ($Value -replace "'", "''") + "'" }

$Me = [Environment]::UserName
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Out-Telepy 'platform' 'Windows' ('{0} root={1}' -f $Me, [int]$IsAdmin)

$Stop = New-Object System.Collections.Generic.List[string]
$Late = New-Object System.Collections.Generic.List[string]
$Pids = New-Object System.Collections.Generic.List[int]
$Scripts = New-Object System.Collections.Generic.List[string]
function Add-Stop([string]$Line, [string]$What, [string]$Detail) { $Stop.Add($Line); Out-Telepy 'scheduled' $What $Detail }
function Remove-TelepyFile([string]$Path, [string]$What) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Remove-Item -LiteralPath $Path -Force
    if (Test-Path -LiteralPath $Path) { Out-Telepy 'needs_root' $What ('Remove-Item -Force {0}  (as Administrator)' -f (Quote $Path)) }
    else { Out-Telepy 'removed' $What $Path }
}
function Add-Script([string]$Text) {
    foreach ($m in [regex]::Matches([string]$Text, $ScriptRe)) {
        if ((Test-Port $m.Value) -and -not $Scripts.Contains($m.Value)) { $Scripts.Add($m.Value) }
    }
}

# --- processes: ssh.exe running this tunnel, and the PowerShell loop of the Telepy script around it ----
$Procs = @(Get-CimInstance Win32_Process)
$ById = @{}
foreach ($p in $Procs) { $ById[[int]$p.ProcessId] = $p }
foreach ($p in $Procs) {
    $cl = [string]$p.CommandLine
    if (-not $cl -or $cl -notmatch $ProcRe -or $cl -notmatch 'ssh' -or $cl -match 'telepy-remove-tunnel|telepy-stop-') { continue }
    Out-Telepy 'found' 'process' ('{0} {1}' -f $p.ProcessId, $cl)
    $Pids.Add([int]$p.ProcessId)
    $parent = $ById[[int]$p.ParentProcessId]
    # 範本的 while 迴圈會在 5 秒後重開 ssh，所以先停它。/ The template loop restarts ssh after 5 s: stop it first.
    if ($parent -and $parent.Name -match '^(powershell|pwsh)\.exe$') {
        Out-Telepy 'found' 'loop' ('{0} {1}' -f $parent.ProcessId, [string]$parent.CommandLine)
        $Pids.Insert(0, [int]$parent.ProcessId)
        Add-Script $parent.CommandLine
    }
}

# --- scheduled tasks -------------------------------------------------------------------------------
foreach ($t in @(Get-ScheduledTask)) {
    $text = (@($t.Actions) | ForEach-Object { '{0} {1}' -f $_.Execute, $_.Arguments }) -join ' '
    if (-not (Test-Command $text)) { continue }
    Out-Telepy 'found' 'task' ($t.TaskPath + $t.TaskName)
    Add-Script $text
    Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false
    if (Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath) {
        Out-Telepy 'needs_root' 'task' ('Unregister-ScheduledTask -TaskName {0} -Confirm:$false  (as Administrator)' -f (Quote $t.TaskName))
    } else {
        Out-Telepy 'removed' 'task' ($t.TaskPath + $t.TaskName)
    }
}

# --- services (sc.exe / NSSM wrappers) --------------------------------------------------------------
foreach ($s in @(Get-CimInstance Win32_Service)) {
    $params = [string](Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\{0}\Parameters' -f $s.Name)).AppParameters
    $text = [string]$s.PathName + ' ' + $params
    if (-not (Test-Command $text)) { continue }
    Out-Telepy 'found' 'service' $s.Name
    Add-Script $text
    if ($IsAdmin) {
        Add-Stop ('Stop-Service -Name {0} -Force; sc.exe delete {0} | Out-Null' -f (Quote $s.Name)) 'stop' ('service ' + $s.Name)
    } else {
        Out-Telepy 'needs_root' 'service' ('sc.exe stop {0} & sc.exe delete {0}  (as Administrator)' -f $s.Name)
    }
}

# --- Run keys --------------------------------------------------------------------------------------
foreach ($rk in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')) {
    $props = Get-ItemProperty -LiteralPath $rk
    if (-not $props) { continue }
    foreach ($prop in @($props.PSObject.Properties)) {
        if ($prop.Name -like 'PS*') { continue }
        if (-not (Test-Command ([string]$prop.Value))) { continue }
        Out-Telepy 'found' 'run-key' ($rk + '\' + $prop.Name)
        Add-Script $prop.Value
        Remove-ItemProperty -LiteralPath $rk -Name $prop.Name
        if ($null -ne (Get-ItemProperty -LiteralPath $rk -Name $prop.Name)) {
            Out-Telepy 'needs_root' 'run-key' ('Remove-ItemProperty -LiteralPath {0} -Name {1}  (as Administrator)' -f (Quote $rk), (Quote $prop.Name))
        } else {
            Out-Telepy 'removed' 'run-key' ($rk + '\' + $prop.Name)
        }
    }
}

# --- Startup folders ---------------------------------------------------------------------------------
$Shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
    if (-not $dir) { continue }
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -File)) {
        $hit = $false
        if ($f.Extension -eq '.lnk' -and $Shell) {
            $lnk = $Shell.CreateShortcut($f.FullName)
            $text = '{0} {1}' -f $lnk.TargetPath, $lnk.Arguments
            $hit = Test-Command $text
            if ($hit) { Add-Script $text }
        } elseif ($f.Extension -match '^\.(ps1|bat|cmd|vbs)$') {
            $hit = Test-Port $f.FullName
        }
        if (-not $hit) { continue }
        Out-Telepy 'found' 'startup' $f.FullName
        Remove-TelepyFile $f.FullName 'startup'
    }
}

# --- Docker (docker run / docker compose templates) -------------------------------------------------
if (Get-Command docker -ErrorAction SilentlyContinue) {
    $ids = @(docker ps -aq 2>$null)
    if ($LASTEXITCODE -ne 0) {
        Out-Telepy 'note' 'docker' ('could not list containers as {0}; a telepy-tunnel container, if any, is left running' -f $Me)
    }
    foreach ($c in $ids) {
        $envs = @(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $c 2>$null)
        if (-not ($envs | Where-Object { $_ -match ('^SSH_TUNNEL_PORT=' + $TunnelPort + '$') })) { continue }
        $cname = ([string](docker inspect -f '{{.Name}}' $c 2>$null)).TrimStart('/')
        Out-Telepy 'found' 'docker' $cname
        Add-Stop ('docker rm -f {0} | Out-Null' -f $c) 'stop' ('docker ' + $cname)
        $compose = [string](docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' $c 2>$null)
        foreach ($cf in ($compose -split ',')) { if (Test-Port $cf.Trim()) { Remove-TelepyFile $cf.Trim() 'file' } }
        $Late.Add('docker image rm jnovack/autossh:latest 2>$null | Out-Null')
        Out-Telepy 'scheduled' 'log' 'image jnovack/autossh (only if no other container uses it)'
    }
}

# --- scripts: the ones the loop / tasks ran, and downloaded copies near the user ----------------------
foreach ($dir in @($HOME, (Join-Path $HOME 'Desktop'), (Join-Path $HOME 'Downloads'), (Join-Path $HOME 'Documents'))) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
    foreach ($f in @(Get-ChildItem -Path (Join-Path $dir '*') -File -Include *.ps1, *.bat, *.cmd, *.sh, *.yml)) {
        if ((Test-Port $f.FullName) -and -not $Scripts.Contains($f.FullName)) { $Scripts.Add($f.FullName) }
    }
}
foreach ($s in $Scripts) {
    Out-Telepy 'found' 'script' $s
    Remove-TelepyFile $s 'file'
}

# --- this tunnel's key -------------------------------------------------------------------------------
foreach ($k in @(Get-ChildItem -LiteralPath (Join-Path $HOME '.ssh') -File -Filter 'telepy_tunnel_*')) {
    if ($k.Extension -eq '.pub') { continue }
    $pub = $k.FullName + '.pub'
    if (-not (Test-Path -LiteralPath $pub)) { continue }
    $words = ([string](Get-Content -LiteralPath $pub -Raw)).Trim() -split '\s+'
    if ($words.Count -ge 2 -and $words[1] -eq $TunnelKey) {
        Remove-TelepyFile $k.FullName 'key'
        Remove-TelepyFile $pub 'key'
    } else {
        Out-Telepy 'kept' 'key' ($k.FullName + " (another tunnel's key)")
    }
}

# --- the stop script: processes last, parents (the loop) first --------------------------------------
if ($Pids.Count -gt 0) {
    Add-Stop ('Stop-Process -Id {0} -Force' -f ($Pids -join ',')) 'stop' ('processes ' + ($Pids -join ' '))
}
if ($Stop.Count + $Late.Count -gt 0) {
    $path = Join-Path ([IO.Path]::GetTempPath()) ('telepy-stop-{0}-{1}.ps1' -f $TunnelId, [guid]::NewGuid().ToString('N').Substring(0, 8))
    $body = @('# telepy-remove-tunnel stop script (deletes itself)', '$ErrorActionPreference = ''SilentlyContinue''', 'Start-Sleep -Seconds 2') + $Stop + @('Start-Sleep -Seconds 1') + $Late + @('Remove-Item -LiteralPath $PSCommandPath -Force')
    Set-Content -LiteralPath $path -Value $body -Encoding UTF8
    if (Test-Path -LiteralPath $path) { Out-Telepy 'stopscript' 'ps1' $path } else { Out-Telepy 'failed' 'stopscript' $path }
}
Out-Telepy 'done' 'Windows' $Me
