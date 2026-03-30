from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent
SHORTCUTS_DIR = PLUGIN_ROOT / "shortcuts"
BACKUP_ROOT = PLUGIN_ROOT / ".migration_backup"
BACKUP_SHORTCUTS_DIR = BACKUP_ROOT / "shortcuts"
MANIFEST_PATH = BACKUP_ROOT / "manifest.json"


def _run_git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(PLUGIN_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )


def _tracked_shortcut_files() -> list[Path]:
    result = _run_git("ls-files", "shortcuts")
    if result.returncode != 0:
        return []
    paths: list[Path] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        path = PLUGIN_ROOT / line
        if path.is_file():
            paths.append(path)
    return paths


def _backup_shortcuts(files: list[Path]) -> None:
    BACKUP_SHORTCUTS_DIR.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, list[str]] = {"files": []}
    for path in files:
        target = BACKUP_SHORTCUTS_DIR / path.name
        shutil.copy2(path, target)
        manifest["files"].append(path.name)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))


def pre_update() -> None:
    tracked = _tracked_shortcut_files()
    if not tracked:
        return

    _backup_shortcuts(tracked)

    # Revert tracked shortcut files to HEAD so git pull can proceed cleanly.
    _run_git("checkout", "--", "shortcuts")


def install() -> None:
    if not MANIFEST_PATH.exists() or not BACKUP_SHORTCUTS_DIR.exists():
        return

    SHORTCUTS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        manifest = json.loads(MANIFEST_PATH.read_text())
    except Exception:
        manifest = {"files": []}

    for name in manifest.get("files", []):
        src = BACKUP_SHORTCUTS_DIR / name
        dst = SHORTCUTS_DIR / name
        if src.is_file():
            shutil.copy2(src, dst)

    shutil.rmtree(BACKUP_ROOT, ignore_errors=True)
