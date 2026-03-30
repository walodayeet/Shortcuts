from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from agent import AgentContext
from helpers import files, plugins, projects, yaml as yaml_helper
from helpers.skills import split_frontmatter

PLUGIN_NAME = "slash_shortcuts"
SHORTCUTS_DIR = "shortcuts"
SHORTCUT_FILE_SUFFIX = ".shortcut.md"
STANDARD_FRONTMATTER_KEYS = {"name", "description", "display_label", "argument_hint"}
_INVALID_NAME_RE = re.compile(r"[^a-z0-9_-]+")
_MULTI_DASH_RE = re.compile(r"-{2,}")


def sanitize_shortcut_name(raw_name: str) -> str:
    name = (raw_name or "").strip().lower().replace(" ", "-")
    name = _INVALID_NAME_RE.sub("-", name)
    name = _MULTI_DASH_RE.sub("-", name).strip("-_")
    if not name:
        raise ValueError("Shortcut name must contain at least one letter or number")
    return name


def shortcut_file_name(shortcut_name: str) -> str:
    return f"{sanitize_shortcut_name(shortcut_name)}{SHORTCUT_FILE_SUFFIX}"


def get_scope_key(project_name: str = "", agent_profile: str = "") -> str:
    if project_name:
        return "project"
    return "global"


def get_scope_label(project_name: str = "", agent_profile: str = "") -> str:
    scope_key = get_scope_key(project_name, agent_profile)
    if scope_key == "project":
        return "Project"
    return "Global"


def get_scope_directory(project_name: str = "", agent_profile: str = "") -> str:
    return plugins.determine_plugin_asset_path(
        PLUGIN_NAME,
        project_name,
        "",
        SHORTCUTS_DIR,
    )


def ensure_scope_directory(project_name: str = "", agent_profile: str = "") -> str:
    directory = get_scope_directory(project_name, agent_profile)
    Path(directory).mkdir(parents=True, exist_ok=True)
    return directory


def get_scope_payload(project_name: str = "", agent_profile: str = "", *, ensure_directory: bool = False) -> dict[str, Any]:
    directory_path = ensure_scope_directory(project_name, agent_profile) if ensure_directory else get_scope_directory(project_name, agent_profile)
    return {
        "project_name": project_name,
        "agent_profile": agent_profile,
        "scope_key": get_scope_key(project_name, agent_profile),
        "scope_label": get_scope_label(project_name, agent_profile),
        "directory_path": _normalize_client_path(directory_path),
        "exists": os.path.isdir(directory_path),
        "_directory_abs_path": directory_path,
    }


def get_context_scope(context_id: str = "") -> dict[str, str]:
    context = _get_context(context_id)
    if not context:
        return {"project_name": "", "agent_profile": ""}
    return {
        "project_name": projects.get_context_project_name(context) or "",
        "agent_profile": "",
    }


def list_scope_shortcuts(project_name: str = "", agent_profile: str = "") -> tuple[list[dict[str, Any]], dict[str, Any]]:
    scope = get_scope_payload(project_name, agent_profile)
    shortcuts = _load_scope_shortcuts(project_name, agent_profile)
    overrides = _collect_lower_scope_matches(project_name, agent_profile)
    for shortcut in shortcuts:
        override_scopes = overrides.get(shortcut["command"], [])
        shortcut["override_scopes"] = override_scopes
        shortcut["override_count"] = len(override_scopes)
    return shortcuts, strip_private_scope(scope)


def list_effective_shortcuts(project_name: str = "", agent_profile: str = "") -> tuple[list[dict[str, Any]], dict[str, Any]]:
    resolved_scope = get_scope_payload(project_name, agent_profile)
    merged: dict[str, dict[str, Any]] = {}
    for scope_project, scope_agent in _iter_precedence_scopes(project_name, agent_profile):
        for shortcut in _load_scope_shortcuts(scope_project, scope_agent):
            merged.setdefault(shortcut["command"], shortcut)
    effective = sorted(merged.values(), key=lambda item: item["command"])
    return effective, strip_private_scope(resolved_scope)


def get_shortcut(path: str, project_name: str = "", agent_profile: str = "") -> dict[str, Any]:
    shortcut_path = _validate_shortcut_path(path, project_name, agent_profile)
    shortcut = _load_shortcut_file(shortcut_path, project_name=project_name, agent_profile=agent_profile)
    if not shortcut:
        raise ValueError("Shortcut file is invalid or missing required frontmatter")
    return shortcut


def save_shortcut(*, project_name: str = "", agent_profile: str = "", existing_path: str = "", name: str, description: str, display_label: str = "", argument_hint: str = "", instruction: str = "", extra_frontmatter: dict[str, Any] | None = None) -> dict[str, Any]:
    shortcut_name = sanitize_shortcut_name(name)
    shortcut_description = (description or "").strip()
    shortcut_instruction = (instruction or "").strip()
    if not shortcut_description:
        raise ValueError("Shortcut description is required")
    if not shortcut_instruction:
        raise ValueError("Shortcut instruction is required")

    scope_dir = ensure_scope_directory(project_name, agent_profile)
    target_path = files.get_abs_path(scope_dir, shortcut_file_name(shortcut_name))
    existing_abs_path = ""
    if existing_path:
        try:
            existing_abs_path = _validate_shortcut_path(existing_path, project_name, agent_profile)
        except FileNotFoundError:
            existing_abs_path = ""

    if existing_abs_path and not os.path.exists(existing_abs_path):
        existing_abs_path = ""

    if os.path.exists(target_path) and not _paths_equal(target_path, existing_abs_path):
        raise FileExistsError(f'A shortcut named "{shortcut_name}" already exists in this scope')

    frontmatter = _build_frontmatter(
        name=shortcut_name,
        description=shortcut_description,
        display_label=display_label,
        argument_hint=argument_hint,
        extra_frontmatter=extra_frontmatter or {},
    )
    files.write_file(target_path, _build_shortcut_markdown(frontmatter, shortcut_instruction))

    if existing_abs_path and not _paths_equal(existing_abs_path, target_path):
        files.delete_file(existing_abs_path)

    return get_shortcut(target_path, project_name, agent_profile)


def delete_shortcut(path: str, project_name: str = "", agent_profile: str = "") -> None:
    shortcut_path = _validate_shortcut_path(path, project_name, agent_profile)
    files.delete_file(shortcut_path)


def duplicate_shortcut(path: str, project_name: str = "", agent_profile: str = "") -> dict[str, Any]:
    shortcut = get_shortcut(path, project_name, agent_profile)
    duplicated_name = _generate_duplicate_name(shortcut["command"], project_name=project_name, agent_profile=agent_profile)
    return save_shortcut(
        project_name=project_name,
        agent_profile=agent_profile,
        name=duplicated_name,
        description=shortcut["description"],
        display_label=shortcut.get("display_label", ""),
        argument_hint=shortcut.get("argument_hint", ""),
        instruction=shortcut.get("instruction", ""),
        extra_frontmatter=shortcut.get("frontmatter_extra", {}),
    )


def _build_frontmatter(*, name: str, description: str, display_label: str, argument_hint: str, extra_frontmatter: dict[str, Any]) -> dict[str, Any]:
    frontmatter: dict[str, Any] = {
        "name": name,
        "description": description,
    }
    clean_display_label = (display_label or "").strip()
    clean_argument_hint = (argument_hint or "").strip()
    if clean_display_label:
        frontmatter["display_label"] = clean_display_label
    if clean_argument_hint:
        frontmatter["argument_hint"] = clean_argument_hint
    for key, value in (extra_frontmatter or {}).items():
        if key in STANDARD_FRONTMATTER_KEYS:
            continue
        frontmatter[key] = value
    return frontmatter


def _build_shortcut_markdown(frontmatter: dict[str, Any], instruction: str) -> str:
    yaml_block = yaml_helper.dumps(frontmatter).strip()
    clean_instruction = (instruction or "").lstrip("\n").rstrip()
    content = f"---\n{yaml_block}\n---\n"
    if clean_instruction:
        content += f"\n{clean_instruction}\n"
    return content


def _generate_duplicate_name(shortcut_name: str, *, project_name: str = "", agent_profile: str = "") -> str:
    base_name = sanitize_shortcut_name(f"{shortcut_name}-copy")
    candidate = base_name
    counter = 2
    scope_dir = ensure_scope_directory(project_name, agent_profile)
    while os.path.exists(files.get_abs_path(scope_dir, shortcut_file_name(candidate))):
        candidate = f"{base_name}-{counter}"
        counter += 1
    return candidate


def _load_shortcut_file(file_path: str, *, project_name: str = "", agent_profile: str = "") -> dict[str, Any] | None:
    try:
        content = files.read_file(file_path)
    except FileNotFoundError:
        return None

    frontmatter, body, errors = split_frontmatter(content)
    if errors:
        return None

    raw_name = str(frontmatter.get("name") or "").strip()
    description = str(frontmatter.get("description") or "").strip()
    if not raw_name or not description:
        return None

    try:
        shortcut_name = sanitize_shortcut_name(raw_name)
    except ValueError:
        return None

    display_label = str(frontmatter.get("display_label") or "").strip()
    argument_hint = str(frontmatter.get("argument_hint") or "").strip()
    extra_frontmatter = {key: value for key, value in frontmatter.items() if key not in STANDARD_FRONTMATTER_KEYS}
    directory_path = str(Path(file_path).parent)
    return {
        "command": shortcut_name,
        "name": shortcut_name,
        "description": description,
        "display_label": display_label,
        "argument_hint": argument_hint,
        "instruction": body.strip(),
        "path": _normalize_client_path(file_path),
        "directory_path": _normalize_client_path(directory_path),
        "project_name": project_name,
        "agent_profile": agent_profile,
        "scope_key": get_scope_key(project_name, agent_profile),
        "scope_label": get_scope_label(project_name, agent_profile),
        "source_scope_key": get_scope_key(project_name, agent_profile),
        "source_scope_label": get_scope_label(project_name, agent_profile),
        "frontmatter_extra": extra_frontmatter,
    }


def _validate_shortcut_path(path: str, project_name: str = "", agent_profile: str = "") -> str:
    shortcut_path = _to_abs_path(path)
    scope_root = get_scope_directory(project_name, agent_profile)
    if not files.is_in_dir(shortcut_path, scope_root):
        raise ValueError("Shortcut path is outside the selected scope")
    if not shortcut_path.endswith(SHORTCUT_FILE_SUFFIX):
        raise ValueError("Shortcut path must point to a .shortcut.md file")
    if not os.path.exists(shortcut_path):
        raise FileNotFoundError("Shortcut file not found")
    return shortcut_path


def _iter_precedence_scopes(project_name: str, agent_profile: str) -> list[tuple[str, str]]:
    scopes: list[tuple[str, str]] = []
    if project_name:
        scopes.append((project_name, ""))
    scopes.append(("", ""))
    return scopes


def _list_scope_files(scope_dir: str) -> list[str]:
    if not os.path.isdir(scope_dir):
        return []
    files_in_scope = [str(path) for path in Path(scope_dir).glob(f"*{SHORTCUT_FILE_SUFFIX}") if path.is_file()]
    files_in_scope.sort(key=lambda item: Path(item).name.lower())
    return files_in_scope


def _load_scope_shortcuts(project_name: str = "", agent_profile: str = "") -> list[dict[str, Any]]:
    shortcuts: list[dict[str, Any]] = []
    scope_dir = get_scope_directory(project_name, agent_profile)
    for file_path in _list_scope_files(scope_dir):
        shortcut = _load_shortcut_file(file_path, project_name=project_name, agent_profile=agent_profile)
        if shortcut:
            shortcuts.append(shortcut)
    shortcuts.sort(key=lambda item: item["command"])
    return shortcuts


def _collect_lower_scope_matches(project_name: str = "", agent_profile: str = "") -> dict[str, list[str]]:
    lower_scope_matches: dict[str, list[str]] = {}
    for lower_project, lower_agent in _iter_precedence_scopes(project_name, agent_profile)[1:]:
        for shortcut in _load_scope_shortcuts(lower_project, lower_agent):
            lower_scope_matches.setdefault(shortcut["command"], []).append(get_scope_label(lower_project, lower_agent))
    return lower_scope_matches


def _normalize_client_path(path: str) -> str:
    return files.normalize_a0_path(path).replace("\\", "/")


def _paths_equal(path_a: str, path_b: str) -> bool:
    if not path_a or not path_b:
        return False
    return os.path.normcase(os.path.normpath(path_a)) == os.path.normcase(os.path.normpath(path_b))


def _get_context(context_id: str = "") -> AgentContext | None:
    if context_id:
        return AgentContext.get(context_id)
    return AgentContext.current() or AgentContext.first()


def _to_abs_path(path: str) -> str:
    return files.fix_dev_path(path)


def strip_private_scope(scope: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in scope.items() if not key.startswith("_")}
