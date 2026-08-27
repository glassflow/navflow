"""Use cases: an opinionated entry point on top of the ordinary Tares objects.

A *recipe* is code (a Recipe subclass) that declares parameters and turns them into a plan of
sources, views, triggers, agents and MCP servers in catalog shape. An *instance* is one configured
run of a recipe, stored in the DB, that owns the objects it created. Owned objects are ordinary:
the user sees and edits them on their normal pages; the use case page is a representation of them,
not a lock on them.
"""
from .base import PlannedObject, Recipe, UsecaseError
from .engine import Engine
from .registry import get_recipe, list_recipes, register
from . import shared_code_context as _shared_code_context  # noqa: F401  (registers itself)
from . import ai_sre_demo as _ai_sre_demo  # noqa: F401  (registers itself)
from . import challenger_workflow as _challenger_workflow  # noqa: F401  (registers itself)

__all__ = ["Engine", "PlannedObject", "Recipe", "UsecaseError",
           "get_recipe", "list_recipes", "register"]
