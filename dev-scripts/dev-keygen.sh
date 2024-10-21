#!/bin/bash

source "$(dirname "$0")/common.sh"

print_message "$BLUE" "Generating SSH keys for Telepy service..."

# Create placeholder for authorized keys
rm -f ./ssh/root_ssh_key/authorized_keys
touch ./ssh/root_ssh_key/authorized_keys

# Generate keys for outside server
ssh-keygen -f ./ssh/ssh_host_keys/ssh_host_dsa_key -t dsa -C "root@telepy-ssh" -N '' <<<$'\ny' >/dev/null 2>&1
ssh-keygen -f ./ssh/ssh_host_keys/ssh_host_rsa_key -t rsa -C "root@telepy-ssh" -N '' <<<$'\ny' >/dev/null 2>&1
ssh-keygen -f ./ssh/ssh_host_keys/ssh_host_ecdsa_key -t ecdsa -C "root@telepy-ssh" -N '' <<<$'\ny' >/dev/null 2>&1
ssh-keygen -f ./ssh/ssh_host_keys/ssh_host_ed25519_key -t ed25519 -C "root@telepy-ssh" -N '' <<<$'\ny' >/dev/null 2>&1

# Generate keys for backend
ssh-keygen -f ./ssh/backend_ssh_key/id_rsa -t rsa -C "root@telepy-web" -N '' <<<$'\ny' >/dev/null 2>&1

print_message "$GREEN" "SSH keys generated successfully."