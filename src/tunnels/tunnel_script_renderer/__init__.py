from .template_renderer import BaseTemplateRenderer
from .powershell_renderer import PowerShellTemplate
from .autossh_renderer import AutoSshTemplate


def ssh_tunnel_script_factory(tunnel_type: str, server_domain: str, reverse_port: int, ssh_port: int, reverse_server_ssh_port: int) -> BaseTemplateRenderer:
    
    tunnel_type = tunnel_type.lower() # Normalize `tunnel_type`.
    if tunnel_type == "powershell":
        template = PowerShellTemplate.template_factory(server_domain=server_domain, reverse_port=reverse_port, ssh_port=ssh_port, reverse_server_ssh_port=reverse_server_ssh_port)
        return template
    elif tunnel_type == "autossh":
        template = AutoSshTemplate.template_factory(server_domain=server_domain, reverse_port=reverse_port, ssh_port=ssh_port, reverse_server_ssh_port=reverse_server_ssh_port)
        return template
    else:
        raise ValueError(f"Invalid tunnel type {tunnel_type}.")