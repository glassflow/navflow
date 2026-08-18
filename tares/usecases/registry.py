"""Recipes register by key. Built-in recipes import this module and call register() at import
time; tests register their own. Keep the registry a plain dict so it is inspectable."""
from __future__ import annotations

from .base import Recipe, UsecaseError

_RECIPES: dict[str, Recipe] = {}


def register(recipe: Recipe) -> Recipe:
    if not recipe.key:
        raise UsecaseError("a recipe needs a key")
    _RECIPES[recipe.key] = recipe
    return recipe


def unregister(key: str) -> None:
    _RECIPES.pop(key, None)


def get_recipe(key: str) -> Recipe:
    try:
        return _RECIPES[key]
    except KeyError:
        raise UsecaseError(f"unknown recipe {key!r} (available: {', '.join(sorted(_RECIPES))})")


def list_recipes() -> list[Recipe]:
    return [_RECIPES[k] for k in sorted(_RECIPES)]
