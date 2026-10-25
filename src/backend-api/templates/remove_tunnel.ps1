# telepy-remove-tunnel: run by Telepy over SSH when a tunnel is deleted (Windows).
# Same contract as remove_tunnel.sh: find what runs THIS tunnel (matched by its key — the -i file of a
# command — or, for older scripts, its reverse port; nothing else is touched), remove its files now and
# write the stopping part into a one-shot stop script that Telepy starts last. Every result is a line "TELEPY|<kind>|<what>|<detail>".
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
# 任何 -R forward（新腳本寫 0，改認金鑰）。/ Any -R forward at all (new scripts ask for 0; the key tells).
$AnyRRe = '-[A-Za-z]*R ?[''"]?([^ :''"]*:)?[0-9]+:'
$EnvRe = 'SSH_TUNNEL_PORT[=:][" ]*' + $TunnelPort + '([^0-9]|$)'
$ScriptRe = '[A-Za-z]:\\[^"*?<>|]*?\.(ps1|bat|cmd|vbs)'
$KeyRe = '(?:-i ?|IdentityFile[ =]|KEY_FILE=)[''"]?([^ ''"]+)'

# ~ 與 $env:USERPROFILE 展開。/ Expand ~ and %USERPROFILE%-style prefixes.
function Expand-KeyPath([string]$Path) {
    $p = $Path -replace '^~', $HOME -replace '^\$env:USERPROFILE', $HOME -replace '^%USERPROFILE%', $HOME
    return [Environment]::ExpandEnvironmentVariables($p)
}
# 這個私鑰檔是不是這條隧道的金鑰：先看旁邊的 .pub，沒有就用 ssh-keygen。/ The .pub next to it first, else ssh-keygen.
function Test-KeyFile([string]$Path) {
    $f = Expand-KeyPath $Path
    if (-not $f -or -not (Test-Path -LiteralPath $f -PathType Leaf)) { return $false }
    $pub = $f + '.pub'
    if (Test-Path -LiteralPath $pub) {
        $words = ([string](Get-Content -LiteralPath $pub -Raw)).Trim() -split '\s+'
        if ($words.Count -ge 2 -and $words[1] -eq $TunnelKey) { return $true }
    }
    $keygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue
    if (-not $keygen) { return $false }
    $out = [string](& $keygen.Source -y -f $f 2>$null)
    $words = $out.Trim() -split '\s+'
    return ($words.Count -ge 2 -and $words[1] -eq $TunnelKey)
}
# 這段文字引用到這條隧道的金鑰？/ Does this text refer to the tunnel's key?
function Test-UsesKey([string]$Text) {
    foreach ($m in [regex]::Matches([string]$Text, $KeyRe)) { if (Test-KeyFile $m.Groups[1].Value) { return $true } }
    return $false
}
# 檔案是這條隧道的：寫著它的號碼（舊腳本），或引用它的金鑰。/ A file of this tunnel: its number, or its key.
function Test-Port([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $text = [string](Get-Content -LiteralPath $Path -Raw)
    return ($text -match $PortRe) -or ($text -match $EnvRe) -or (Test-UsesKey $text)
}
# 命令列是這條隧道的：-R 帶它的號碼、-R 任何號碼加上它的金鑰，或指到它的腳本（絕不碰只有 -L 的）。
# A command line of this tunnel: -R with its number, any -R plus its key, or pointing at its script (never -L only).
function Test-Command([string]$Text) {
    if (-not $Text) { return $false }
    if ($Text -match $ProcRe) { return $true }
    if (($Text -match $AnyRRe) -and (Test-UsesKey $Text)) { return $true }
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
    if (-not $cl -or $cl -notmatch 'ssh' -or $cl -match 'telepy-remove-tunnel|telepy-stop-') { continue }
    if (-not (($cl -match $ProcRe) -or (($cl -match $AnyRRe) -and (Test-UsesKey $cl)))) { continue }
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
        if (-not ($envs | Where-Object { $_ -match ('^SSH_TUNNEL_PORT=' + $TunnelPort + '$') })) {
            # 新容器：掛到 /id_rsa 的金鑰是這條隧道的。/ New containers: the key mounted at /id_rsa is the tunnel's.
            $mounted = [string](docker inspect -f '{{range .Mounts}}{{if eq .Destination "/id_rsa"}}{{.Source}}{{end}}{{end}}' $c 2>$null)
            if (-not $mounted -or -not (Test-KeyFile $mounted.Trim())) { continue }
        }
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
