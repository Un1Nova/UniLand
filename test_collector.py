#!/usr/bin/env python3
"""Meaningful privacy/opt-in/part-limit tests for the PowerShell collector.

Run with the path to a local PowerShell executable. No network, credentials,
or real client files are used. Temporary fixtures are removed automatically.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib

from unpack_client_inputs import unpack

SCRIPT = Path(__file__).with_name("Collect-TmrClient.ps1").resolve()
CANARY = b"DO_NOT_COLLECT_CREDENTIAL_CANARY_9a386c"


def write(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)


def png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff")) + chunk(b"IEND", b"")


def jar(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as out:
        out.writestr("assets/example/textures/items/example.png", png())
        out.writestr("fixture.bin", data)


def run(pwsh: str, args: list[str], *, stdin: str = "", env=None):
    return subprocess.run([pwsh, "-NoLogo", "-NoProfile", "-File", str(SCRIPT), *args], input=stdin, text=True, capture_output=True, timeout=120, env=env)


def main() -> None:
    pwsh = sys.argv[1]
    checks = []
    with tempfile.TemporaryDirectory(prefix="tmr-collector-fixture-") as temp:
        root = Path(temp)
        appdata = root / "APPDATA"
        clients = appdata / ".loliland/game-resources/clients"
        client = clients / "fixture-client/main"
        private = root / "private"
        write(appdata / ".loliland/launcher-data/storage.txt", b"access_token=" + CANARY)
        write(appdata / ".loliland/storage.txt", b"password=" + CANARY)
        jar(client / "mods/normal.jar", b"ordinary mod fixture")
        jar(client / "mods/large.jar", bytes(range(251)) * 7300)
        jar(client / "client.jar", b"base client fixture")
        write(client / "mods/pretend.jar", CANARY)
        write(client / "mods/readme.txt", CANARY)
        write(client / "scripts/main.zs", 'recipes.addShapeless(<fixture:output>, [<fixture:input>]);')
        write(client / "scripts/unsafe.zs", b'val password = "' + CANARY + b'";')
        write(client / "scripts/utf16.zs", ('api_key="' + CANARY.decode() + '"').encode("utf-16"))
        write(client / "scripts/password.zs", CANARY)
        write(client / "scripts/auth.zs", CANARY)
        write(client / "scripts/accounts.zs", CANARY)
        write(client / "scripts/session.zs", CANARY)
        write(client / "config/scripts_cache.dat", b"\xac\xed\x00\x05SAFE_CACHE_FIXTURE_NOT_A_REAL_EXPORT")
        write(client / "config/recipe-safe.cfg", "recipeEnabled=true\namount=4\n")
        write(client / "config/recipes/unsafe.json", b'{"access_token":"' + CANARY + b'"}')
        write(client / "config/recipes/unsafe-url.cfg", b"endpoint=https://user:" + CANARY + b"@example.invalid/")
        write(client / "config/recipes/late-secret.cfg", b"#" * 65520 + b"\npassword=" + CANARY)
        write(client / "config/launcher-data/recipe.txt", CANARY)
        write(client / "config/logs/recipe.cfg", CANARY)
        write(client / "config/accounts.json", CANARY)
        write(client / "config/general.cfg", CANARY)
        write(client / "servers.dat", CANARY)
        write(client / "storage.txt", CANARY)
        write(client / "logs/latest.log", CANARY)
        write(client / "saves/world/data.dat", CANARY)
        write(client / "screenshots/private.png", CANARY)
        write(client / "assets/example/textures/items/real.png", png())
        write(client / "assets/example/textures/items/false.png", CANARY)
        write(client / "assets/example/lang/ru_RU.lang", "item.example.name=Example\n")
        write(client / "assets/example/lang/private.lang", b"email=" + CANARY)
        jar(private / "outside.jar", CANARY)
        write(private / "assets/example/lang/hidden.lang", b"email=" + CANARY)
        (client / "mods/linked.jar").symlink_to(private / "outside.jar")
        (client / "mods/linked-directory").symlink_to(private, target_is_directory=True)
        (client / "resources").symlink_to(private, target_is_directory=True)

        expected = {
            "mods/normal.jar", "mods/large.jar", "client.jar", "scripts/main.zs",
            "config/scripts_cache.dat", "config/recipe-safe.cfg",
            "assets/example/textures/items/real.png", "assets/example/lang/ru_RU.lang",
        }
        dry = root / "dry-run"
        p = run(pwsh, ["-ClientPath", str(client), "-OutputDirectory", str(dry), "-NonInteractive"])
        assert p.returncode == 0, p.stdout + p.stderr
        inv = json.loads((dry / "inventory.json").read_text(encoding="utf-8-sig"))
        assert {f["path"] for f in inv["files"]} == expected
        assert list(dry.glob("*.zip")) == []
        assert inv["runtimeExport"] is False and inv["complete"] is False and inv["recipesExported"] == 0
        assert CANARY not in (dry / "inventory.json").read_bytes()
        assert str(root).encode() not in (dry / "inventory.json").read_bytes()
        checks.append("default_noninteractive_inventory_only_exact_allowlist_no_private_absolute_paths")

        packed = root / "packed"
        p = run(pwsh, ["-ClientPath", str(client), "-OutputDirectory", str(packed), "-CreateZip", "-NonInteractive", "-MaxPartMiB", "1"])
        assert p.returncode == 0, p.stdout + p.stderr
        manifest = json.loads((packed / "inventory.json").read_text(encoding="utf-8-sig"))
        archives = sorted(packed.glob("*.zip"))
        assert len(archives) >= 3
        assert len(archives) == len(manifest["archives"])
        chunks = {}
        for archive in archives:
            assert archive.stat().st_size <= 1048576
            archive_info = next(a for a in manifest["archives"] if a["name"] == archive.name)
            assert archive_info["sha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
            with zipfile.ZipFile(archive) as z:
                part = json.loads(z.read("part-manifest.json"))
                assert part["collectionId"] == manifest["collectionId"]
                assert part["runtimeExport"] is False
                for name in z.namelist():
                    assert CANARY not in z.read(name), name
                for entry in part["entries"]:
                    data = z.read(entry["entry"])
                    assert len(data) == entry["bytes"]
                    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
                    chunks.setdefault(entry["path"], []).append((entry["offset"], data))
        assert set(chunks) == expected
        for name, pieces in chunks.items():
            rebuilt = b"".join(data for _, data in sorted(pieces))
            assert rebuilt == (client / name).read_bytes()
            fi = next(f for f in manifest["files"] if f["path"] == name)
            assert hashlib.sha256(rebuilt).hexdigest() == fi["sha256"]
        checks.append("explicit_zip_opt_in_every_part_below_limit_large_file_reconstructs_hashes_match")
        checks.append("no_credential_canary_in_inventory_or_any_archive_entry")
        checks.append("symlink_files_directories_and_linked_resource_ancestors_not_followed")

        reconstructed = root / "reconstructed"
        result = unpack(packed, reconstructed)
        assert result["files"] == len(expected) and result["runtimeExport"] is False
        for name in expected:
            assert (reconstructed / name).read_bytes() == (client / name).read_bytes()
        checks.append("production_reconstructor_verifies_all_parts_and_rebuilds_input_tree")

        cancel = root / "interactive-cancel"
        p = run(pwsh, ["-ClientPath", str(client), "-OutputDirectory", str(cancel)], stdin="\n")
        assert p.returncode == 0, p.stdout + p.stderr
        assert (cancel / "inventory.json").exists() and not list(cancel.glob("*.zip"))
        checks.append("interactive_empty_answer_creates_no_zip")

        env = dict(os.environ, APPDATA=str(appdata), USERPROFILE=str(root / "user"))
        noselect = root / "no-selection"
        p = run(pwsh, ["-OutputDirectory", str(noselect), "-NonInteractive"], env=env)
        assert p.returncode != 0 and not noselect.exists()
        assert str(client) in p.stdout
        checks.append("unknown_profile_never_auto_selected_even_if_only_candidate")
        selected = root / "user-selected"
        p = run(pwsh, ["-OutputDirectory", str(selected)], env=env, stdin="1\n\n")
        assert p.returncode == 0, p.stdout + p.stderr
        assert (selected / "inventory.json").exists() and not list(selected.glob("*.zip"))
        checks.append("standard_appdata_discovery_and_explicit_number_selection")

        link = root / "client-link"
        link.symlink_to(client, target_is_directory=True)
        linked_out = root / "linked-output"
        p = run(pwsh, ["-ClientPath", str(link), "-OutputDirectory", str(linked_out), "-NonInteractive", "-CreateZip"])
        assert p.returncode != 0 and not linked_out.exists()
        checks.append("linked_input_root_rejected_before_output")

        p = run(pwsh, ["-ClientPath", str(client), "-OutputDirectory", str(dry), "-NonInteractive", "-CreateZip"])
        assert p.returncode != 0 and not list(dry.glob("*.zip"))
        checks.append("existing_output_not_overwritten")
        print(json.dumps({"status": "passed", "checks": checks, "syntheticIncludedFiles": len(expected), "syntheticArchivePartsAt1MiBLimit": len(archives), "platform": sys.platform, "powershell": pwsh, "actualWindows51Execution": False}, indent=2))


if __name__ == "__main__":
    main()
