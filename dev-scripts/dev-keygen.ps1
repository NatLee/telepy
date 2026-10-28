# Generate SSH keys for Telepy service
# 已存在的金鑰一律保留：裝置釘選了 gateway 的主機金鑰、也信任服務金鑰，換新的會把所有裝置擋在外面。
# 真的要重來，先自己刪掉檔案。
# Existing keys are always kept: devices pin the gateway's host keys and trust the service key, so new ones would
# lock every connected device out. To start over on purpose, delete the files first.

# Import common functions
. "$PSScriptRoot/common.ps1"

# Check if ssh-keygen is available
if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    Write-ColorMessage $Colors.Red "Error: ssh-keygen not found. Please install OpenSSH or Git for Windows."
    Write-ColorMessage $Colors.Yellow "You can install OpenSSH via: Add-WindowsCapability -Online -Name OpenSSH.Client"
    exit 1
}

Write-ColorMessage $Colors.Blue "Generating SSH keys for Telepy service..."
New-Item -Path "./ssh/ssh_host_keys", "./ssh/backend_ssh_key" -ItemType Directory -Force | Out-Null

# 空密碼怎麼傳給 ssh-keygen 要看 PowerShell 怎麼傳參數給外部程式：Windows PowerShell 5.1 與 7.0–7.2（Legacy）會丟掉空字串，
# 得寫成 '""'；7.3 起（Standard / Windows）空字串照傳，'""' 反而變成兩個引號字元的密碼，金鑰被加密、後端讀不了。
# An empty passphrase depends on how PowerShell passes arguments to native programs: Windows PowerShell 5.1 and
# 7.0–7.2 (Legacy) drop an empty string, so it has to be '""'; from 7.3 (Standard / Windows) an empty string is passed
# as is, and '""' would become a passphrase of two quote characters — an encrypted key the backend cannot read.
$EmptyPassphrase = if ($null -ne $PSNativeCommandArgumentPassing -and "$PSNativeCommandArgumentPassing" -ne "Legacy") { "" } else { '""' }

function New-TelepyKey([string]$Path, [string]$Type, [string]$Comment) {
    if (Test-Path $Path) {
        if (-not (Test-Path "$Path.pub")) {
            $public = & ssh-keygen -y -f $Path
            if ($LASTEXITCODE -ne 0) { return $false }
            # ASCII without a BOM (Windows PowerShell's `>` would write UTF-16).
            [System.IO.File]::WriteAllText("$((Resolve-Path $Path).Path).pub", "$public`n", [System.Text.Encoding]::ASCII)
            Write-ColorMessage $Colors.Yellow "  kept $Path, restored its .pub"
        } else {
            Write-ColorMessage $Colors.Yellow "  kept $Path (already there)"
        }
        return $true
    }
    & ssh-keygen -q -f $Path -t $Type -C $Comment -N $EmptyPassphrase | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
    Write-ColorMessage $Colors.Green "  created $Path"
    return $true
}

# Host keys for the backend's SSH gateway (ed25519 for modern clients, RSA for old ones)
$results = @(
    (New-TelepyKey "./ssh/ssh_host_keys/ssh_host_rsa_key" "rsa" "root@telepy-ssh"),
    (New-TelepyKey "./ssh/ssh_host_keys/ssh_host_ed25519_key" "ed25519" "root@telepy-ssh"),
    # Service key: the backend logs in to devices with it (devices add the public half to authorized_keys)
    (New-TelepyKey "./ssh/backend_ssh_key/id_rsa" "rsa" "root@telepy-web")
)
if ($results -contains $false) {
    Write-ColorMessage $Colors.Red "Error: some keys could not be generated."
    exit 1
}
Write-ColorMessage $Colors.Green "SSH keys are ready."
