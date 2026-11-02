"""Инвентаризация клиентских архивов без выполнения кода модов.

Скрипт описывает реальные API и ресурсы, но не превращает соседние строки или
имена файлов в предполагаемые рецепты. Полный экспорт требует отдельного
адаптера к обнаруженным реестрам.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import zipfile


RECIPE_TERMS = re.compile(r"recipe|crafting|ingredient|loliindex|luminous.+index|ore.?dict", re.I)
RESOURCE_TERMS = re.compile(r"recipe|craft|index|script|registry", re.I)


class Reader:
    def __init__(self, data: bytes):
        self.file = io.BytesIO(data)

    def read(self, amount):
        result = self.file.read(amount)
        if len(result) != amount:
            raise ValueError("Обрезанный class-файл")
        return result

    def u1(self):
        return self.read(1)[0]

    def u2(self):
        return struct.unpack(">H", self.read(2))[0]

    def u4(self):
        return struct.unpack(">I", self.read(4))[0]


def class_metadata(data: bytes):
    reader = Reader(data)
    if reader.u4() != 0xCAFEBABE:
        raise ValueError("Неверная сигнатура class-файла")
    minor, major = reader.u2(), reader.u2()
    pool = [None] * reader.u2()
    index = 1
    while index < len(pool):
        tag = reader.u1()
        if tag == 1:
            pool[index] = (tag, reader.read(reader.u2()).decode("utf-8", errors="replace"))
        elif tag in (3, 4):
            pool[index] = (tag, reader.read(4).hex())
        elif tag in (5, 6):
            pool[index] = (tag, reader.read(8).hex())
            index += 1
        elif tag in (7, 8, 16, 19, 20):
            pool[index] = (tag, reader.u2())
        elif tag in (9, 10, 11, 12, 17, 18):
            pool[index] = (tag, reader.u2(), reader.u2())
        elif tag == 15:
            pool[index] = (tag, reader.u1(), reader.u2())
        else:
            raise ValueError(f"Неизвестный constant-pool tag: {tag}")
        index += 1

    def text(index):
        entry = pool[index] if index else None
        if entry is None:
            return None
        if entry[0] == 1:
            return entry[1]
        if entry[0] in (7, 8, 16, 19, 20):
            return text(entry[1])
        return str(entry)

    access, name, superclass = reader.u2(), text(reader.u2()), text(reader.u2())
    interfaces = [text(reader.u2()) for _ in range(reader.u2())]

    def skip_attributes():
        for _ in range(reader.u2()):
            reader.u2()
            reader.read(reader.u4())

    def members():
        result = []
        for _ in range(reader.u2()):
            flags, member_name, descriptor = reader.u2(), text(reader.u2()), text(reader.u2())
            result.append({"name": member_name, "descriptor": descriptor, "accessFlags": flags})
            skip_attributes()
        return result

    fields, methods = members(), members()
    skip_attributes()
    references = sorted({text(n) for n, entry in enumerate(pool) if entry and entry[0] == 7})
    return {
        "name": name,
        "superclass": superclass,
        "interfaces": interfaces,
        "classVersion": [major, minor],
        "accessFlags": access,
        "fields": fields,
        "methods": methods,
        "recipeClassReferences": [value for value in references if value and RECIPE_TERMS.search(value)],
    }


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def detect_format(path):
    with path.open("rb") as source:
        prefix = source.read(16)
    if prefix.startswith(b"\xac\xed\x00\x05"):
        return "java-serialization"
    if prefix.startswith(b"PK\x03\x04"):
        return "zip"
    if prefix.startswith(b"\x1f\x8b"):
        return "gzip"
    if prefix.startswith(b"\x28\xb5\x2f\xfd"):
        return "zstandard"
    if prefix.startswith(b"\xca\xfe\xba\xbe"):
        return "java-class"
    if prefix.lstrip().startswith((b"{", b"[")):
        return "possible-json"
    return "unknown"


def inspect(inputs, output):
    files = []
    for path in inputs:
        if path.is_dir():
            files.extend(p for p in path.rglob("*") if p.is_file() and p.suffix.lower() in {".jar", ".zip", ".dat", ".zs", ".json"})
        elif path.is_file():
            files.append(path)
    files = sorted(set(path.resolve() for path in files))
    output.mkdir(parents=True, exist_ok=True)
    archives, candidate_apis, resources, caches, errors = [], [], [], [], []
    for path in files:
        summary = {"path": str(path), "sizeBytes": path.stat().st_size, "sha256": digest(path)}
        if path.suffix.lower() not in {".jar", ".zip"}:
            if RESOURCE_TERMS.search(path.name):
                caches.append(dict(summary, format=detect_format(path)))
            continue
        try:
            with zipfile.ZipFile(path) as archive:
                entries = archive.infolist()
                counters = collections.Counter()
                for entry in entries:
                    if entry.is_dir():
                        continue
                    name = entry.filename
                    if name.endswith(".class"):
                        counters["classes"] += 1
                        if entry.file_size > 8 * 1024 * 1024:
                            errors.append({"archive": str(path), "entry": name, "reason": "class-too-large"})
                            continue
                        metadata = class_metadata(archive.read(entry))
                        if RECIPE_TERMS.search(metadata["name"]) or metadata["recipeClassReferences"]:
                            metadata["archive"] = path.name
                            candidate_apis.append(metadata)
                            counters["recipeCandidateClasses"] += 1
                    elif name.lower().endswith(".png"):
                        counters["pngTextures"] += 1
                        resources.append({"archive": path.name, "path": name, "sizeBytes": entry.file_size, "kind": "texture"})
                    elif name.lower().endswith(".lang"):
                        counters["languageFiles"] += 1
                        resources.append({"archive": path.name, "path": name, "sizeBytes": entry.file_size, "kind": "language"})
                    elif RESOURCE_TERMS.search(name) and name.lower().endswith((".json", ".zs", ".dat", ".xml", ".bin", ".txt")):
                        counters["recipeCandidateResources"] += 1
                        resources.append({"archive": path.name, "path": name, "sizeBytes": entry.file_size, "kind": "recipe-candidate-resource"})
                summary["counts"] = dict(counters)
                for metadata_name in ["mcmod.info", "META-INF/MANIFEST.MF"]:
                    try:
                        entry = archive.getinfo(metadata_name)
                        if entry.file_size < 64 * 1024:
                            summary[metadata_name] = archive.read(entry).decode("utf-8", errors="replace")
                    except KeyError:
                        pass
                archives.append(summary)
        except Exception as error:
            errors.append({"archive": str(path), "reason": str(error)})
    summary = {
        "archives": len(archives),
        "recipeCandidateClasses": len(candidate_apis),
        "resources": len(resources),
        "cacheCandidates": len(caches),
        "errors": len(errors),
        "recipesExported": 0,
        "note": "Инвентаризация не доказывает полное покрытие рецептов и не является runtime-экспортом.",
    }
    for name, value in [
        ("archives.json", archives),
        ("candidate-apis.json", candidate_apis),
        ("resource-index.json", resources),
        ("cache-inventory.json", caches),
        ("inspection-errors.json", errors),
        ("inspection-summary.json", summary),
    ]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "inspection")
    arguments = parser.parse_args()
    inspect(arguments.inputs, arguments.output)
