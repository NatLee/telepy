#!/bin/bash
#TODO: Constder binding "telepy" command with this script.

# Function for the 'ssh-keygen' sub-command
ssh_keygen_command() {
    # TODO: Capture command arguments with "$1".

    printf "Generating SSH keys for Telepy service...\n"
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
}

# Main script logic
case "$1" in
    keygen)
        shift
        ssh_keygen_command "$@"
        ;;
    *)
        echo "Usage: $0 {keygen|...}"
        ;;
esac
