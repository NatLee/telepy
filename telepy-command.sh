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

command_create_superuser() {
    
    # Function to prompt for input with a default value
    prompt_with_default() {
        local prompt="$1"
        local default="$2"
        local input

        read -p "$prompt [$default]: " input
        echo "${input:-$default}"
    }

    # Get user input
    USERNAME=$(prompt_with_default "Enter username" "admin")
    EMAIL=$(prompt_with_default "Enter email" "admin@admin.com")
    PASSWORD=$(prompt_with_default "Enter password" "1234")

    # Create superuser
    docker exec -it telepy-web-${PROJECT_NAME} bash -c "DJANGO_SUPERUSER_PASSWORD='$PASSWORD' python manage.py createsuperuser --noinput --username '$USERNAME' --email '$EMAIL'"
}

command_exec() {
    # Run arbitrary command.
    docker exec -it telepy-web-${PROJECT_NAME} bash
}

command_ipython() {
    # Run ipython shell.
    docker exec -it telepy-web-${PROJECT_NAME} bash -c 'python manage.py shell'
}

command_supervisor_ctl() {
    # Run supervisor controll shell.
    docker exec -it telepy-web-${PROJECT_NAME} supervisorctl -c /etc/supervisor/conf.d/supervisord.conf
}

command_ssh_shell() {
    # Run ssh shell.
    docker exec -it telepy-ssh-${PROJECT_NAME} bash
}

command_migration() {
    # Run migration.
    docker exec -it telepy-web-${PROJECT_NAME} bash -c 'python manage.py makemigrations && python manage.py migrate'
}

### Main script logic

# Load environment variables
export $(grep -v '^#' .env | xargs)

case "$1" in
    keygen)
        shift
        ssh_keygen_command "$@"
        ;;
    create-superuser)
        shift
        command_create_superuser "$@"
        ;;
    shell)
        shift
        command_exec "$@"
        ;;
    ipython)
        shift
        command_ipython "$@"
        ;;
    supervisorctl)
        shift
        command_supervisor_ctl "$@"
        ;;
    ssh-shell)
        shift
        command_ssh_shell "$@"
        ;;
    migration)
        shift
        command_migration "$@"
        ;;
    *)
        echo "Usage: $0 {keygen|create-superuser}"
        ;;
esac
