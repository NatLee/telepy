from string import Template
from pathlib import Path
from .template_renderer import BaseTemplateRenderer

# Absolute path of template directory path.
# NOTE: change if the directory structure changed.
TEMPLATE_DIR = Path(__file__).resolve().parent / Path("templates")

SSH_CLIENT_PROXY_CONF = "ProxyCommand ssh -W %h:%p telepy-ssh-server"

class BaseSshTemplate(BaseTemplateRenderer):

    def __init__(self, 
                 server_side: bool, 
                 host_friendly_name: str,
                 server_domain: str, 
                 ssh_username: str,
                 reverse_port: int, 
                 ssh_port: int, 
                 reverse_server_ssh_port: int):

        super().__init__(server_domain=server_domain, 
                         reverse_port=reverse_port, 
                         ssh_port=ssh_port, 
                         reverse_server_ssh_port=reverse_server_ssh_port)
        
        self.server_side = server_side
        self.ssh_username = ssh_username
        self.host_friendly_name = host_friendly_name

    def mapping_factory(self) -> dict:

        mapping = super().mapping_factory()

        mapping["ssh_username"] = self.ssh_username
        mapping["host_friendly_name"] = self.host_friendly_name

        # Check if server side or client side.
        if not self.server_side:  # Client side.
            mapping["client_proxy_command"] = SSH_CLIENT_PROXY_CONF
        else:
            mapping["client_proxy_command"] = ""

        return mapping

    @classmethod 
    def template_factory(cls, 
                         server_side: bool, 
                         host_friendly_name: str,
                         server_domain: str, 
                         ssh_username: str,
                         reverse_port: int, 
                         ssh_port: int, 
                         reverse_server_ssh_port: int) -> "BaseSshTemplate":
        return cls(server_side=server_side, 
                   host_friendly_name=host_friendly_name,
                   server_domain=server_domain, 
                   ssh_username=ssh_username,
                   reverse_port=reverse_port, 
                   ssh_port=ssh_port, 
                   reverse_server_ssh_port=reverse_server_ssh_port)
    
    def render(self) -> str:
        
        # Define mapping.
        mapping = self.mapping_factory()

        # Load template file.
        template_file = TEMPLATE_DIR / Path("ssh_config_template.conf")

        # Render template.
        template = Template(template_file.read_text())
        rendered_template = template.safe_substitute(mapping)
        
        return rendered_template