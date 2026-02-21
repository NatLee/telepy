from string import Template
from pathlib import Path
from .template_renderer import BaseTemplateRenderer

# Absolute path of template directory path.
# NOTE: change if the directory structure changed.
TEMPLATE_DIR = Path(__file__).resolve().parent / Path("templates")

class AutoSshServiceTemplate(BaseTemplateRenderer):

    def __init__(
        self,
        server_domain: str,
        reverse_port: int,
        ssh_port: int,
        reverse_server_ssh_port: int,
        username: str="root",
        key_path: str=None,
    ) -> None:

        super().__init__(
            server_domain=server_domain, 
            reverse_port=reverse_port, 
            ssh_port=ssh_port, 
            reverse_server_ssh_port=reverse_server_ssh_port,
            username=username,
        )
        
        self.key_path = key_path


    @classmethod 
    def template_factory(cls, server_domain: str, reverse_port: int, ssh_port: int, reverse_server_ssh_port: int, username:str, key_path: str=None) -> "AutoSshServiceTemplate":
        return cls(server_domain, reverse_port, ssh_port, reverse_server_ssh_port, username, key_path)
    
    def mapping_factory(self) -> dict:
        mapping = super().mapping_factory()
        
        # Add key_path to mapping if provided
        # For service files, we don't want line breaks - keep everything on one line
        if self.key_path:
            mapping["key_option"] = f"-i {self.key_path} "
        else:
            mapping["key_option"] = ""
            
        return mapping
    
    def render(self) -> str:

        # Define mapping.
        mapping = self.mapping_factory()

        # Load template file.
        template_file = TEMPLATE_DIR / Path("autossh_template.service")

        # Render template.
        template = Template(template_file.read_text())
        rendered_template = template.safe_substitute(mapping)
        
        return rendered_template