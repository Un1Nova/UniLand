#!/usr/bin/env python3
"""Build from an explicit current runtime export. Never fall back to old archives."""
import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT
SOURCE = ROOT / "current/catalog.json"
TARGET = DIST / "catalog.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def validate(catalog, require_complete=False):
    require(catalog.get("schemaVersion") == 1, "Unsupported schemaVersion")
    for key in ("items", "recipes", "mods"):
        require(isinstance(catalog.get(key), list), f"{key} must be a list")
    meta = catalog.get("meta", {})
    items, recipes = catalog["items"], catalog["recipes"]
    item_ids, recipe_ids = set(), set()
    for item in items:
        iid = item.get("id")
        require(isinstance(iid, str) and iid and iid not in item_ids, f"Invalid or duplicate item: {iid}")
        require(isinstance(item.get("name"), str) and item["name"], f"Missing item name: {iid}")
        item_ids.add(iid)
        icon = item.get("icon", "")
        if icon and not icon.startswith(("https://", "data:image/")):
            target = (DIST / icon).resolve()
            require(target.is_relative_to(DIST.resolve()) and target.is_file(), f"Missing or unsafe icon: {icon}")
    for recipe in recipes:
        rid = recipe.get("id")
        require(isinstance(rid, str) and rid and rid not in recipe_ids, f"Invalid or duplicate recipe: {rid}")
        recipe_ids.add(rid)
        require(recipe.get("verification") == "runtime", f"Recipe is not a runtime export: {rid}")
        require(isinstance(recipe.get("inputs"), list), f"Missing inputs: {rid}")
        require(isinstance(recipe.get("outputs"), list) and recipe["outputs"], f"Missing outputs: {rid}")
        w, h = recipe.get("width"), recipe.get("height")
        if w is not None or h is not None:
            require(type(w) is int and type(h) is int and 1 <= w <= 9 and 1 <= h <= 9, f"Invalid grid: {rid}")
        for stack in recipe["inputs"] + recipe["outputs"]:
            require(stack.get("itemId") in item_ids, f"Unknown item: {rid}")
            require(positive(stack.get("count", 1)), f"Invalid quantity: {rid}")
            require(all(a in item_ids for a in stack.get("alternatives", [])), f"Unknown alternative: {rid}")
            if "chance" in stack:
                p = stack["chance"]
                require(type(p) in (int, float) and math.isfinite(p) and 0 <= p <= 1, f"Chance must be 0..1: {rid}")
            if "slot" in stack:
                require(w is not None and type(stack["slot"]) is int and 0 <= stack["slot"] < w * h, f"Invalid slot: {rid}")
    coverage = meta.get("coverage", {})
    if items or recipes:
        value = meta.get("exportedAt")
        require(isinstance(value, str), "Runtime exportedAt is required; checkedAt is not freshness evidence")
        exported = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(exported.tzinfo is not None, "exportedAt must include timezone")
        age = datetime.now(timezone.utc) - exported
        require(timedelta(minutes=-5) <= age <= timedelta(days=14), "Export is older than 14 days or dated in the future")
        require(coverage.get("runtimeExport") is True, "Current runtime export is required")
    if meta.get("status") == "complete" or coverage.get("complete") or require_complete:
        require(bool(items) and bool(recipes), "Empty catalog cannot be complete")
        require(meta.get("status") == "complete" and coverage.get("complete") is True, "Complete status and coverage must agree")
        require(coverage.get("runtimeExport") is True and coverage.get("registryEnumerated") is True, "Runtime registries were not enumerated")
        require(meta.get("serverSynchronized") is True, "Server synchronization is not confirmed")
        require(bool(meta.get("clientManifestSha256")), "Client manifest fingerprint is missing")
        handlers = coverage.get("handlers", [])
        require(bool(handlers), "Recipe handler inventory is missing")
        require(all(h.get("status") == "exported" and type(h.get("sourceCount")) is int and h["sourceCount"] >= 0 and h["sourceCount"] == h.get("exportedCount") for h in handlers), "Some recipe handlers are incomplete")
        require(all(item.get("icon") for item in items), "Some inventory sprites are missing")
    require(coverage.get("items", len(items)) == len(items), "Item total does not match")
    require(coverage.get("recipes", len(recipes)) == len(recipes), "Recipe total does not match")
    return catalog


def empty_catalog():
    return {
        "schemaVersion": 1,
        "meta": {
            "title": "LoliLand · TechnoMagic RPG", "minecraftVersion": "1.7.10",
            "checkedAt": datetime.now(timezone.utc).date().isoformat(), "status": "unavailable",
            "description": "Актуальная выгрузка рецептов ещё не получена.",
            "sources": [
                {"title": "TechnoMagic RPG", "url": "https://loliland.ru/ru/servers/techno-magic-rpg"},
                {"title": "Официальный лаунчер", "url": "https://loliland.ru/ru/start"}],
            "coverage": {"items": 0, "recipes": 0, "runtimeRecipes": 0, "complete": False, "runtimeExport": False, "registryEnumerated": False, "handlers": []}
        }, "mods": [], "items": [], "recipes": []
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    path = TARGET if args.validate_only else args.source
    if path.exists():
        catalog = json.loads(path.read_text(encoding="utf-8"))
    else:
        require(not args.validate_only, f"Missing catalog: {path}")
        catalog = empty_catalog()
    validate(catalog, args.require_complete)
    if not args.validate_only:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"status": catalog["meta"]["status"], "items": len(catalog["items"]), "recipes": len(catalog["recipes"]), "exportedAt": catalog["meta"].get("exportedAt")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
