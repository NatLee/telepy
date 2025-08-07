from string import Template
from pathlib import Path
from .template_renderer import BaseTemplateRenderer

# Absolute path of template directory path.
# NOTE: change if the directory structure changed.
TEMPLATE_DIR = Path(__file__).resolve().parent / Path("templates")

class DockerTemplate(BaseTemplateRenderer):

    def __init__(self, server_domain: str, reverse_port: int, ssh_port: int, reverse_server_ssh_port: int, key_path: str = None, docker_type: str = "run"):

        super().__init__(server_domain=server_domain, 
                         reverse_port=reverse_port, 
                         ssh_port=ssh_port, 
                         reverse_server_ssh_port=reverse_server_ssh_port)
        
        self.key_path = key_path
        self.docker_type = docker_type

    @classmethod 
    def template_factory(cls, server_domain: str, reverse_port: int, ssh_port: int, reverse_server_ssh_port: int, key_path: str = None, docker_type: str = "run") -> "DockerTemplate":
        return cls(server_domain, reverse_port, ssh_port, reverse_server_ssh_port, key_path, docker_type)
    
    def mapping_factory(self) -> dict:
        mapping = super().mapping_factory()
        
        # Add key_path to mapping if provided
        if self.key_path:
            mapping["key_mount"] = f"  -v {self.key_path}:/root/.ssh/id_rsa:ro"
            mapping["key_option"] = "  -i /root/.ssh/id_rsa"
        else:
            mapping["key_mount"] = ""
            mapping["key_option"] = ""
            
        # Add docker type
        mapping["docker_type"] = self.docker_type
        
        # Add Telepy public key (this should be the service key)
        try:
            from authorized_keys.models import ServiceAuthorizedKeys
            service_key = ServiceAuthorizedKeys.objects.first()
            if service_key:
                mapping["telepy_public_key"] = service_key.key
            else:
                mapping["telepy_public_key"] = "# Telepy public key not found"
        except:
            mapping["telepy_public_key"] = "# Telepy public key not found"
            
        return mapping
    
    def render(self) -> str:
        # Define mapping.
        mapping = self.mapping_factory()

        # Load template file based on docker type
        if self.docker_type == "compose":
            template_file = TEMPLATE_DIR / Path("docker_compose_template.yml")
        else:  # docker run
            template_file = TEMPLATE_DIR / Path("docker_run_template.sh")

        # Render template.
        template = Template(template_file.read_text())
        rendered_template = template.safe_substitute(mapping)
        
        return rendered_template
