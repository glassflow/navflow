"""Templates register by key. Built-in templates import this module and call register() at import
time; tests register their own. Keep the registry a plain dict so it is inspectable."""
from __future__ import annotations

from .base import Template, ProjectError

_RECIPES: dict[str, Template] = {}


def register(template: Template) -> Template:
    if not template.key:
        raise ProjectError("a template needs a key")
    _RECIPES[template.key] = template
    return template


def unregister(key: str) -> None:
    _RECIPES.pop(key, None)


def get_template(key: str) -> Template:
    try:
        return _RECIPES[key]
    except KeyError:
        raise ProjectError(f"unknown template {key!r} (available: {', '.join(sorted(_RECIPES))})")


def list_templates() -> list[Template]:
    return [_RECIPES[k] for k in sorted(_RECIPES)]
