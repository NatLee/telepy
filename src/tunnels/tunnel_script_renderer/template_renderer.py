from abc import ABC, abstractmethod

class BaseTemplateRenderer(ABC):

    def __init__(self, server_domain: str, 
                 reverse_port: int, 
                 ssh_port: int, 
                 reverse_server_ssh_port: int) -> None:
        self.server_domain = server_domain
        self.reverse_port = reverse_port
        self.ssh_port = ssh_port
        self.reverse_server_ssh_port = reverse_server_ssh_port

    def mapping_factory(self) -> dict:
        return {
            "server_domain": self.server_domain,
            "reverse_port": self.reverse_port,
            "ssh_port": self.ssh_port,
            "reverse_server_ssh_port": self.reverse_server_ssh_port
        }

    @abstractmethod
    def render(self) -> str: ...

    @classmethod
    @abstractmethod
    def template_factory(cls, **kwargs) -> "BaseTemplateRenderer": ...