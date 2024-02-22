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
