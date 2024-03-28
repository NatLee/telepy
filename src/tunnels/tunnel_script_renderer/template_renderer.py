from abc import ABC, abstractmethod

class BaseTemplateRenderer(ABC):
    @abstractmethod
    def render(self) -> str: ...

    @classmethod
    @abstractmethod
    def template_factory(cls, **kwargs) -> "BaseTemplateRenderer": ...