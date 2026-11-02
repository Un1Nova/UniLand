#!/usr/bin/env python3
"""Verify and reconstruct an offline Collect-TmrClient.ps1 collection.

Use: python unpack_client_inputs.py UPLOADED_FOLDER --output NEW_CLIENT_FOLDER
Requires inventory.json and every ZIP part listed in it. Nothing is executed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import zipfile


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value:
        raise ValueError("Invalid relative file path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError("Unsafe relative file path")
    if any(ord(c) < 32 for c in value):
        raise ValueError("Control character in path")
    return path


def unpack(source: Path, output: Path) -> dict:
    inventory_path = source / "inventory.json"
    inventory = json.loads(inventory_path.read_text(encoding="utf-8-sig"))
    if inventory.get("schema") != "loliland-client-inputs-v1":
        raise ValueError("Unsupported collection schema")
    if output.exists() or output.is_symlink():
        raise FileExistsError("Output must be a new directory")
    expected = {}
    for record in inventory["files"]:
        relative_path(record["path"])
        if record["path"] in expected or record["bytes"] < 0:
            raise ValueError("Duplicate or invalid inventory file")
        expected[record["path"]] = record
    archive_list = inventory.get("archives", [])
    if not archive_list:
        raise ValueError("Inventory has no archives; this was an inventory-only run")
    for archive in archive_list:
        name = archive["name"]
        if not re.fullmatch(r"tmr-inputs-part\d+\.zip", name):
            raise ValueError("Unexpected archive filename")
        file = source / name
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"Missing or linked archive: {name}")
        if file.stat().st_size != archive["bytes"] or digest(file) != archive["sha256"]:
            raise ValueError(f"Archive size/hash mismatch: {name}")

    pieces = {name: [] for name in expected}
    output.mkdir(parents=True)
    try:
        for archive in archive_list:
            with zipfile.ZipFile(source / archive["name"]) as z:
                if z.getinfo("part-manifest.json").file_size > 4 * 1024 * 1024:
                    raise ValueError("Unreasonably large part manifest")
                part = json.loads(z.read("part-manifest.json"))
                if part.get("schema") != "loliland-client-input-part-v1" or part.get("collectionId") != inventory["collectionId"]:
                    raise ValueError("Mismatched collection part")
                allowed_entries = {"part-manifest.json"}
                for entry in part["entries"]:
                    name = entry["path"]
                    if name not in expected:
                        raise ValueError("Unlisted input file in archive")
                    record = expected[name]
                    if entry["fileBytes"] != record["bytes"] or entry["fileSha256"] != record["sha256"]:
                        raise ValueError("Conflicting file manifest")
                    offset, length = entry["offset"], entry["bytes"]
                    if not isinstance(offset, int) or not isinstance(length, int) or min(offset, length) < 0 or offset + length > record["bytes"]:
                        raise ValueError("Invalid chunk bounds")
                    entry_name = entry["entry"]
                    relative_path(entry_name)
                    if entry_name in allowed_entries:
                        raise ValueError("Duplicate ZIP entry")
                    allowed_entries.add(entry_name)
                    info = z.getinfo(entry_name)
                    if info.file_size != length:
                        raise ValueError("Chunk ZIP size mismatch")
                    target = output.joinpath(*relative_path(name).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    h = hashlib.sha256()
                    with z.open(entry_name) as inp, target.open("r+b" if target.exists() else "w+b") as out:
                        out.seek(offset)
                        count = 0
                        while block := inp.read(1024 * 1024):
                            count += len(block)
                            if count > length:
                                raise ValueError("Chunk exceeded its declared size")
                            h.update(block)
                            out.write(block)
                    if count != length or h.hexdigest() != entry["sha256"]:
                        raise ValueError("Chunk hash mismatch")
                    pieces[name].append((offset, length))
                if len(z.namelist()) != len(allowed_entries) or set(z.namelist()) != allowed_entries:
                    raise ValueError("Unlisted or duplicate entries in ZIP")
        for name, record in expected.items():
            next_offset = 0
            if not pieces[name]:
                raise ValueError(f"Missing file: {name}")
            for offset, length in sorted(pieces[name]):
                if offset != next_offset:
                    raise ValueError(f"Missing or overlapping chunks: {name}")
                next_offset += length
            target = output.joinpath(*relative_path(name).parts)
            if next_offset != record["bytes"] or target.stat().st_size != record["bytes"] or digest(target) != record["sha256"]:
                raise ValueError(f"Reconstructed file hash mismatch: {name}")
        shutil.copyfile(inventory_path, output / "_collection-manifest.json")
        return {"status": "verified-inputs-only", "files": len(expected), "archives": len(archive_list), "runtimeExport": False, "recipesExported": 0}
    except BaseException:
        shutil.rmtree(output)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collection", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(unpack(args.collection, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
