import re
from string import Template
from pathlib import Path
from xmlrpc import server
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
            mapping["reverse_server_ssh_port"] = ""

        else:
            mapping["client_proxy_command"] = ""
            mapping["reverse_port"] = ""

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
    
class SshClientTemplate(BaseSshTemplate):
    def __init__(self, 
                 host_friendly_name: str,
                 ssh_username: str,
                 reverse_port: int):
        
        super().__init__(server_side=False,
                         host_friendly_name=host_friendly_name,
                         server_domain="localhost",
                         ssh_username=ssh_username,
                         reverse_port=reverse_port,
                         ssh_port=-1,                   # It seems these variable are not used in `views.py`
                         reverse_server_ssh_port=-1)    # So I just to an impossible value.

    @classmethod 
    def template_factory(cls, 
                         host_friendly_name: str,
                         ssh_username: str,
                         reverse_port: int) -> "SshClientTemplate":
        return cls(host_friendly_name=host_friendly_name,
                   ssh_username=ssh_username,
                   reverse_port=reverse_port)
    
class SshServerTemplate(BaseSshTemplate):
    def __init__(self, 
                 server_domain: str,
                 reverse_server_ssh_port: int):
        
        super().__init__(server_side=True,
                         host_friendly_name="telepy-ssh-server",  # Follows the implementation in `views.py`.
                         ssh_username="telepy",                   # Follows the implementation in `views.py`. 
                         server_domain=server_domain,
                         reverse_server_ssh_port=reverse_server_ssh_port,    
                         ssh_port=-1,                   # It seems these variable are not used in `views.py`
                         reverse_port=-1)               # So I just to an impossible value.

    @classmethod 
    def template_factory(cls, 
                         server_domain: str,
                         reverse_server_ssh_port: int) -> "SshServerTemplate":
        return cls(server_domain=server_domain,
                   reverse_server_ssh_port=reverse_server_ssh_port)