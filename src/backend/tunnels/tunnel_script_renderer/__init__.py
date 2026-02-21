from .template_renderer import BaseTemplateRenderer
from .powershell_renderer import PowerShellTemplate
from .autossh_renderer import AutoSshTemplate
from .autossh_service_renderer import AutoSshServiceTemplate
from .ssh_renderer import SshTemplate
from .ssh_config_renderer import SshClientTemplate, SshServerTemplate
from .docker_renderer import DockerTemplate


def ssh_tunnel_script_factory(
    tunnel_type: str,
    server_domain: str,
    reverse_port: int,
    ssh_port: int,
    reverse_server_ssh_port: int,
    username:str="root",
    key_path: str=None) -> BaseTemplateRenderer:
    
    tunnel_type = tunnel_type.lower() # Normalize `tunnel_type`.
    if tunnel_type == "powershell":
        template = PowerShellTemplate.template_factory(
            server_domain=server_domain,
            reverse_port=reverse_port,
            ssh_port=ssh_port,
            reverse_server_ssh_port=reverse_server_ssh_port,
            key_path=key_path
        )
        return template
    elif tunnel_type == "ssh":
        template = SshTemplate.template_factory(
            server_domain=server_domain,
            reverse_port=reverse_port,
            ssh_port=ssh_port,
            reverse_server_ssh_port=reverse_server_ssh_port,
            key_path=key_path
        )
        return template
    elif tunnel_type == "autossh":
        template = AutoSshTemplate.template_factory(
            server_domain=server_domain,
            reverse_port=reverse_port,
            ssh_port=ssh_port,
            reverse_server_ssh_port=reverse_server_ssh_port,
            key_path=key_path
        )
        return template
    elif tunnel_type == "autossh-service":
        template = AutoSshServiceTemplate.template_factory(
            server_domain=server_domain,
            reverse_port=reverse_port,
            ssh_port=ssh_port,
            reverse_server_ssh_port=reverse_server_ssh_port,
            username=username,
            key_path=key_path
        )
        return template
    elif tunnel_type == "docker-run":
        template = DockerTemplate.template_factory(
            server_domain=server_domain,
            reverse_port=reverse_port,
            ssh_port=ssh_port,
            reverse_server_ssh_port=reverse_server_ssh_port,
            key_path=key_path,
            docker_type="run"
        )
        return template
    elif tunnel_type == "docker-compose":
        template = DockerTemplate.template_factory(
            server_domain=server_domain,
            reverse_port=reverse_port,
            ssh_port=ssh_port,
            reverse_server_ssh_port=reverse_server_ssh_port,
            key_path=key_path,
            docker_type="compose"
        )
        return template
    else:
        raise ValueError(f"Invalid tunnel type {tunnel_type}.")

def sshd_client_config_factory(host_friendly_name: str, ssh_username: str, reverse_port: int) -> SshClientTemplate:
    template = SshClientTemplate.template_factory(host_friendly_name=host_friendly_name, ssh_username=ssh_username, reverse_port=reverse_port)
    return template

def sshd_server_config_factory(server_domain: str, reverse_server_ssh_port: int) -> SshServerTemplate:
    template = SshServerTemplate.template_factory(server_domain=server_domain, reverse_server_ssh_port=reverse_server_ssh_port)
    return template