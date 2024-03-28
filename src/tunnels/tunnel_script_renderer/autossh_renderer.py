from string import Template
from typing import NamedTuple
from pathlib import Path
from .template_renderer import BaseTemplateRenderer

# Absolute path of template directory path.
# NOTE: change if the directory structure changed.
TEMPLATE_DIR = Path(__file__).resolve().parent / Path("templates")

class AutoSshTemplate(BaseTemplateRenderer):

    def __init__(self, server_domain: str, reverse_port: int, ssh_port: int, reverse_server_ssh_port: int):

        super().__init__() # It does nothing, but incase it really does something in the future.

        self.server_domain = server_domain
        self.reverse_port = reverse_port
        self.ssh_port = ssh_port
        self.reverse_server_ssh_port = reverse_server_ssh_port

    @classmethod 
    def template_factory(cls, server_domain: str, reverse_port: int, ssh_port: int, reverse_server_ssh_port: int) -> "AutoSshTemplate":
        return cls(server_domain, reverse_port, ssh_port, reverse_server_ssh_port)
    
    def render(self) -> str:
        # Define mapping.
        mapping = {
            "server_domain": self.server_domain,
            "reverse_port": self.reverse_port,
            "ssh_port": self.ssh_port,
            "reverse_server_ssh_port": self.reverse_server_ssh_port
        }

        # Load template file.
        template_file = TEMPLATE_DIR / Path("autossh_template.sh")

        # Render template.
        template = Template(template_file.read_text())
        rendered_template = template.safe_substitute(mapping)
        
        return rendered_template