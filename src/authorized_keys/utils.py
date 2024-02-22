from typing import List
import re
import subprocess
import base64

def is_valid_ssh_public_key(key: str) -> bool:
    """
    Check if the provided string is a valid SSH public key format.
    
    Args:
    - key (str): The SSH public key as a string.

    Returns:
    - bool: True if the key is in a valid format, False otherwise.
    """

    # Common SSH key prefixes
    valid_prefixes = ["ssh-rsa", "ssh-dss", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-ed25519"]

    try:
        # Split the key into its components
        parts = key.strip().split()
        
        # Check if the key format starts with a valid prefix and has at least two parts
        if len(parts) < 2 or parts[0] not in valid_prefixes:
            return False
        
        # Decode the key part to check if it's correctly base64 encoded
        key_body = parts[1]
        base64.b64decode(key_body)
        return True
    except Exception:
        return False


def ssh(command:str, hostname:str):
    """
    Executes an SSH command on a remote server using subprocess.
    
    Args:
    - command (str): The command to execute.
    - hostname (str): Hostname or IP address of the SSH server.

    Returns:
    - str: The output from the command execution.
    """
    ssh_command = f"ssh {hostname} {command}"
    result = subprocess.run(ssh_command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    
    if result.returncode != 0:
        raise Exception(f"SSH command execution failed: {result.stderr}")

    return result.stdout

def monitor_reverse_tunnel() -> List[int]:
    ss_output = ssh(command="ss -tlnp", hostname="telepy-ssh")
    return parse_ss_ports(ss_output)

def parse_ss_ports(ss_output:str):
    ports = []
    for line in ss_output.splitlines():
        match = re.search(r'LISTEN\s+\d+\s+\d+\s+[\d.:]*:(\d+)', line)
        if match:
            ports.append(int(match.group(1)))
    return ports
