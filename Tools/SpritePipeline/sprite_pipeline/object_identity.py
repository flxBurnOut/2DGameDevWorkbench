"""Typed object identity with unchanged historical JSON shapes."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, PrivateAttr, model_serializer, model_validator


ObjectType = Literal["character", "interactable"]


class ObjectIdentity(BaseModel):
    object_id: str
    object_type: ObjectType = "character"
    _legacy_identity: bool = PrivateAttr(default=False)

    @model_validator(mode="wrap")
    @classmethod
    def read_legacy_identity(cls, value, handler):
        # Assignment validates an existing instance; preserve its storage shape.
        if isinstance(value, cls):
            return handler(value)
        legacy = False
        if isinstance(value, dict):
            value = dict(value)
            legacy = "object_id" not in value and "object_type" not in value
            if "character_id" in value:
                old = value.pop("character_id")
                if "object_id" in value and value["object_id"] != old:
                    raise ValueError("object_id and character_id must identify the same object")
                value.setdefault("object_id", old)
        result = handler(value)
        result._legacy_identity = legacy and result.object_type == "character"
        return result

    @property
    def character_id(self) -> str:
        """Readable compatibility alias for older callers and stored jobs."""
        return self.object_id

    def identity_fields(self) -> dict[str, str]:
        if self._legacy_identity and self.object_type == "character":
            return {"character_id": self.object_id}
        return {"object_id": self.object_id, "object_type": self.object_type}

    def preserve_identity_shape(self, data):
        if self._legacy_identity and self.object_type == "character":
            if "object_id" in data:
                data["character_id"] = data.pop("object_id")
            data.pop("object_type", None)
        return data

    @model_serializer(mode="wrap")
    def serialize_object_identity(self, handler):
        return self.preserve_identity_shape(handler(self))
