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

from tunnels.consumers import send_notification_to_group
from authorized_keys.models import ReverseServerAuthorizedKeys

PORTS = []

def parse_ss_ports_from_redis(ss_output:str) -> List[int]:
    ports = []
    for line in ss_output.split(' LISTEN '):
        match = re.search(r'^0 128 (127\.0\.0\.1|0\.0\.0\.0):(\d+)', line)
        if match:
            ports.append(int(match.group(2)))
    reverse_ports = ReverseServerAuthorizedKeys.objects.all().values_list("reverse_port", flat=True)
    return list(set(ports) & set(reverse_ports))

def get_ss_output_from_redis() -> List[int]:
    # Retrieve the value from Redis
    result = subprocess.run("redis-cli -h telepy-redis GET ss_output", shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result is None:
        return []
    parsed_output = parse_ss_ports_from_redis(result.stdout)
    global PORTS
    if set(parsed_output) != set(PORTS):
        # Send notification for the updated reverse server status
        send_notification_to_group(message={
            "action": "UPDATE-TUNNEL-STATUS-DATA",
            "data": parsed_output,
            "details": "Reverse server status have been updated",
        })

        # Send notification for each port that have been connected or disconnected
        for port in set(PORTS) - set(parsed_output):
            send_notification_to_group(message={
                "action": "UPDATE-TUNNEL-STATUS",
                "details": f"Port [{port}] have been disconnected",
            })
        for port in set(parsed_output) - set(PORTS):
            send_notification_to_group(message={
                "action": "UPDATE-TUNNEL-STATUS",
                "details": f"Port [{port}] have been connected",
            })
        PORTS = parsed_output
    return parsed_output
