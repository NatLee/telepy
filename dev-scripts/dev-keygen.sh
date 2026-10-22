#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Generating SSH keys for Telepy service..."

mkdir -p ./ssh/ssh_host_keys ./ssh/backend_ssh_key

# Host keys for the backend's SSH gateway (ed25519 for modern clients, RSA for old ones)
ssh-keygen -f ./ssh/ssh_host_keys/ssh_host_rsa_key -t rsa -C "root@telepy-ssh" -N '' <<<$'\ny' >/dev/null 2>&1
ssh-keygen -f ./ssh/ssh_host_keys/ssh_host_ed25519_key -t ed25519 -C "root@telepy-ssh" -N '' <<<$'\ny' >/dev/null 2>&1

# Service key: the backend logs in to devices with it (devices add the public half to authorized_keys)
ssh-keygen -f ./ssh/backend_ssh_key/id_rsa -t rsa -C "root@telepy-web" -N '' <<<$'\ny' >/dev/null 2>&1

print_message "$GREEN" "SSH keys generated successfully."
