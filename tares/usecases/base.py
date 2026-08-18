"""The recipe contract. A recipe is pure: `plan()` returns what should exist for given params and
has no side effects; the engine does the applying and the diffing."""
from __future__ import annotations

from dataclasses import dataclass, field

KINDS = ("source", "view", "trigger", "agent", "mcp_server")


class UsecaseError(ValueError):
    pass


@dataclass
class PlannedObject:
    """One desired object. `kind` picks the catalog table; `key` is stable across re-plans for the
    same logical object (e.g. `source:owner/repo`), so a re-plan can tell "changed" from "new" and
    "removed"; `spec` is the object in catalog-import shape (the dict the YAML importer accepts,
    including `name`)."""
    kind: str
    key: str
    spec: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.kind not in KINDS:
            raise UsecaseError(f"unknown planned object kind {self.kind!r}")
        if not self.key:
            raise UsecaseError("planned object needs a key")
        if not self.spec.get("name"):
            raise UsecaseError(f"planned {self.kind} {self.key!r} has no name in its spec")

    @property
    def name(self) -> str:
        return str(self.spec["name"])


class Recipe:
    """Subclass and register (see registry.py). PARAMS uses the connector CONFIG_SCHEMA style:
    {name: {type, required, default, help, ...}} so the console can render a form from it."""
    key: str = ""
    title: str = ""
    description: str = ""
    PARAMS: dict = {}
    # Free-form labels the console shows on the card ("demo" marks a use case that needs the demo
    # stack rather than your systems).
    tags: tuple = ()
    # Steps a user must do outside Tares before Start (start a stack, export a key), each
    # {title, text?, command?}; the wizard shows them above the Start button.
    SETUP: list = []
    # Buttons the instance page offers, each {name, label, help?, params?: {name: {label, options}}};
    # the engine routes them to run_action().
    ACTIONS: list = []

    def validate(self, params: dict) -> dict:
        """Check required params and fill defaults; return the normalized params. Recipes may
        override for cross-field rules; call super() first."""
        out = dict(params or {})
        for name, spec in (self.PARAMS or {}).items():
            if spec.get("required") and out.get(name) in (None, "", [], {}):
                raise UsecaseError(f"{self.key}: missing required parameter {name!r}")
            if name not in out and "default" in spec:
                out[name] = spec["default"]
        return out

    def preflight(self, params: dict, store) -> None:
        """Optional checks that need the store (a referenced credential exists, ...), run by the
        engine after validate() and before plan() on create and update. Raise UsecaseError."""
        return None

    def plan(self, params: dict) -> list[PlannedObject]:
        raise NotImplementedError

    def summary(self, instance: dict, store) -> dict:
        """What the use case page shows beyond the object list. Default: nothing extra."""
        return {}

    def after_create(self, instance: dict, store, runtime) -> None:
        """Optional hook the engine calls once after a successful create, with the runtime (None
        while the daemon boots from a catalog file). Best effort: an error here is logged on the
        instance and never undoes the create."""
        return None

    def run_action(self, instance: dict, action: str, args: dict, store, runtime) -> dict:
        """Perform one of ACTIONS for a running instance; return what the page should show.
        Raise UsecaseError for a bad action or arguments."""
        raise UsecaseError(f"{self.key}: no action {action!r}")

    def describe(self) -> dict:
        return {"key": self.key, "title": self.title, "description": self.description,
                "params": self.PARAMS, "tags": list(self.tags), "setup": list(self.SETUP),
                "actions": list(self.ACTIONS)}
