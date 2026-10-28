#!/bin/bash

source "$(dirname "$0")/common.sh"

# 已存在的金鑰一律保留：裝置釘選了 gateway 的主機金鑰、也信任服務金鑰，換新的會把所有裝置擋在外面。
# 真的要重來，先自己刪掉檔案。
# Existing keys are always kept: devices pin the gateway's host keys and trust the service key, so new ones would
# lock every connected device out. To start over on purpose, delete the files first.

if ! command -v ssh-keygen >/dev/null 2>&1; then
    print_message "$RED" "Error: ssh-keygen not found. Install OpenSSH (openssh-client) first."
    exit 1
fi

print_message "$BLUE" "Generating SSH keys for Telepy service..."
mkdir -p ./ssh/ssh_host_keys ./ssh/backend_ssh_key

# $1 = key file, $2 = type, $3 = comment
make_key() {
    if [ -f "$1" ]; then
        if [ ! -f "$1.pub" ]; then
            ssh-keygen -y -f "$1" > "$1.pub" || return 1
            print_message "$YELLOW" "  kept $1, restored its .pub"
        else
            print_message "$YELLOW" "  kept $1 (already there)"
        fi
    else
        ssh-keygen -q -f "$1" -t "$2" -C "$3" -N '' || return 1
        print_message "$GREEN" "  created $1"
    fi
}

ok=0
# Host keys for the backend's SSH gateway (ed25519 for modern clients, RSA for old ones)
make_key ./ssh/ssh_host_keys/ssh_host_rsa_key rsa root@telepy-ssh || ok=1
make_key ./ssh/ssh_host_keys/ssh_host_ed25519_key ed25519 root@telepy-ssh || ok=1
# Service key: the backend logs in to devices with it (devices add the public half to authorized_keys)
make_key ./ssh/backend_ssh_key/id_rsa rsa root@telepy-web || ok=1

if [ $ok -eq 0 ]; then
    print_message "$GREEN" "SSH keys are ready."
else
    print_message "$RED" "Error: some keys could not be generated."
fi
exit $ok
