from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from agent import AgentContext
from helpers import files, plugins, projects, yaml as yaml_helper
from helpers.skills import split_frontmatter

PLUGIN_NAME = "slash_shortcuts"
SHORTCUTS_DIR = "shortcuts"
SHORTCUT_FILE_SUFFIX = ".shortcut.md"
STANDARD_FRONTMATTER_KEYS = {"name", "description", "display_label", "argument_hint"}
DRAFTS_DIR = "drafts"
DRAFT_FILE_SUFFIX = ".draft.md"
STANDARD_DRAFT_FRONTMATTER_KEYS = {"id", "title", "note", "created_at", "updated_at"}
DRAFT_SCOPE_GLOBAL = "global"
DRAFT_SCOPE_PROJECT = "project"
DRAFT_SCOPE_CHAT = "chat"
VALID_DRAFT_SCOPE_KEYS = {DRAFT_SCOPE_GLOBAL, DRAFT_SCOPE_PROJECT, DRAFT_SCOPE_CHAT}
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


def sanitize_draft_id(raw_id: str) -> str:
    draft_id = (raw_id or "").strip().lower().replace(" ", "-")
    draft_id = _INVALID_NAME_RE.sub("-", draft_id)
    draft_id = _MULTI_DASH_RE.sub("-", draft_id).strip("-_")
    if not draft_id:
        raise ValueError("Draft id must contain at least one letter or number")
    return draft_id


def draft_file_name(draft_id: str) -> str:
    return f"{sanitize_draft_id(draft_id)}{DRAFT_FILE_SUFFIX}"


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
    project_name = projects.get_context_project_name(context) or ""
    if not project_name:
        output_project = context.get_output_data("project")
        if isinstance(output_project, dict):
            project_name = str(output_project.get("name", "") or "")
    return {
        "project_name": project_name,
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


def get_draft_scope_key(scope_key: str = "", project_name: str = "", context_id: str = "") -> str:
    normalized_scope = (scope_key or "").strip().lower()
    if normalized_scope:
        if normalized_scope not in VALID_DRAFT_SCOPE_KEYS:
            raise ValueError("Draft scope must be one of: global, project, chat")
        return normalized_scope
    if context_id:
        return DRAFT_SCOPE_CHAT
    if project_name:
        return DRAFT_SCOPE_PROJECT
    return DRAFT_SCOPE_GLOBAL


def get_draft_scope_label(scope_key: str = "", project_name: str = "", context_id: str = "") -> str:
    resolved_scope = get_draft_scope_key(scope_key, project_name, context_id)
    if resolved_scope == DRAFT_SCOPE_CHAT:
        return "Chat"
    if resolved_scope == DRAFT_SCOPE_PROJECT:
        return "Project"
    return "Global"


def get_draft_scope_directory(scope_key: str = "", project_name: str = "", context_id: str = "") -> str:
    resolved_scope = get_draft_scope_key(scope_key, project_name, context_id)
    resolved_project_name, resolved_context_id = _resolve_draft_scope_context(project_name, context_id)
    base_dir = plugins.determine_plugin_asset_path(
        PLUGIN_NAME,
        resolved_project_name if resolved_scope in {DRAFT_SCOPE_PROJECT, DRAFT_SCOPE_CHAT} else "",
        "",
        DRAFTS_DIR,
    )
    if resolved_scope == DRAFT_SCOPE_CHAT:
        if not resolved_context_id:
            raise ValueError("Chat-scoped drafts require a context_id")
        return files.get_abs_path(base_dir, "chats", sanitize_draft_id(resolved_context_id))
    if resolved_scope == DRAFT_SCOPE_PROJECT:
        if not resolved_project_name:
            raise ValueError("Project-scoped drafts require a project_name or resolvable context")
        return base_dir
    return base_dir


def ensure_draft_scope_directory(scope_key: str = "", project_name: str = "", context_id: str = "") -> str:
    directory = get_draft_scope_directory(scope_key, project_name, context_id)
    Path(directory).mkdir(parents=True, exist_ok=True)
    return directory


def get_draft_scope_payload(scope_key: str = "", project_name: str = "", context_id: str = "", *, ensure_directory: bool = False) -> dict[str, Any]:
    resolved_scope = get_draft_scope_key(scope_key, project_name, context_id)
    resolved_project_name, resolved_context_id = _resolve_draft_scope_context(project_name, context_id)
    directory_path = ensure_draft_scope_directory(resolved_scope, resolved_project_name, resolved_context_id) if ensure_directory else get_draft_scope_directory(resolved_scope, resolved_project_name, resolved_context_id)
    return {
        "project_name": resolved_project_name,
        "agent_profile": "",
        "context_id": resolved_context_id,
        "scope_key": resolved_scope,
        "scope_label": get_draft_scope_label(resolved_scope, resolved_project_name, resolved_context_id),
        "directory_path": _normalize_client_path(directory_path),
        "exists": os.path.isdir(directory_path),
        "_directory_abs_path": directory_path,
    }


def list_scope_drafts(scope_key: str = "", project_name: str = "", context_id: str = "") -> tuple[list[dict[str, Any]], dict[str, Any]]:
    scope = get_draft_scope_payload(scope_key, project_name, context_id)
    drafts = _load_scope_drafts(
        scope_key=scope["scope_key"],
        project_name=scope["project_name"],
        context_id=scope["context_id"],
    )
    return drafts, strip_private_scope(scope)


def get_draft(path: str, scope_key: str = "", project_name: str = "", context_id: str = "") -> dict[str, Any]:
    scope = get_draft_scope_payload(scope_key, project_name, context_id)
    draft_path = _validate_draft_path(
        path,
        scope_key=scope["scope_key"],
        project_name=scope["project_name"],
        context_id=scope["context_id"],
    )
    draft = _load_draft_file(
        draft_path,
        scope_key=scope["scope_key"],
        project_name=scope["project_name"],
        context_id=scope["context_id"],
    )
    if not draft:
        raise ValueError("Draft file is invalid or missing required frontmatter")
    return draft


def save_draft(*, scope_key: str = "", project_name: str = "", context_id: str = "", existing_path: str = "", draft_id: str = "", title: str = "", note: str = "", text: str = "", extra_frontmatter: dict[str, Any] | None = None) -> dict[str, Any]:
    scope = get_draft_scope_payload(scope_key, project_name, context_id, ensure_directory=True)
    draft_text = _normalize_draft_text(text)
    if not draft_text.strip():
        raise ValueError("Draft text is required")

    existing_abs_path = ""
    existing_draft: dict[str, Any] | None = None
    if existing_path:
        try:
            existing_abs_path = _validate_draft_path(
                existing_path,
                scope_key=scope["scope_key"],
                project_name=scope["project_name"],
                context_id=scope["context_id"],
            )
            existing_draft = _load_draft_file(
                existing_abs_path,
                scope_key=scope["scope_key"],
                project_name=scope["project_name"],
                context_id=scope["context_id"],
            )
        except FileNotFoundError:
            existing_abs_path = ""
            existing_draft = None

    resolved_draft_id = sanitize_draft_id(draft_id or (existing_draft or {}).get("id") or _generate_draft_id())
    target_path = files.get_abs_path(scope["_directory_abs_path"], draft_file_name(resolved_draft_id))

    if os.path.exists(target_path) and not _paths_equal(target_path, existing_abs_path):
        raise FileExistsError(f'Draft "{resolved_draft_id}" already exists in this scope')

    now = _iso_utc_now()
    frontmatter = _build_draft_frontmatter(
        draft_id=resolved_draft_id,
        title=title or (existing_draft or {}).get("title", ""),
        note=note or (existing_draft or {}).get("note", ""),
        created_at=(existing_draft or {}).get("created_at", "") or now,
        updated_at=now,
        draft_text=draft_text,
        extra_frontmatter=extra_frontmatter or (existing_draft or {}).get("frontmatter_extra", {}) or {},
    )
    files.write_file(target_path, _build_draft_markdown(frontmatter, draft_text))

    if existing_abs_path and not _paths_equal(existing_abs_path, target_path):
        files.delete_file(existing_abs_path)

    return get_draft(
        target_path,
        scope_key=scope["scope_key"],
        project_name=scope["project_name"],
        context_id=scope["context_id"],
    )


def delete_draft(path: str, scope_key: str = "", project_name: str = "", context_id: str = "") -> None:
    scope = get_draft_scope_payload(scope_key, project_name, context_id)
    draft_path = _validate_draft_path(
        path,
        scope_key=scope["scope_key"],
        project_name=scope["project_name"],
        context_id=scope["context_id"],
    )
    files.delete_file(draft_path)


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


def _build_draft_frontmatter(*, draft_id: str, title: str, note: str, created_at: str, updated_at: str, draft_text: str, extra_frontmatter: dict[str, Any]) -> dict[str, Any]:
    clean_title = (title or "").strip() or _derive_draft_title(draft_text)
    clean_note = (note or "").strip()
    frontmatter: dict[str, Any] = {
        "id": draft_id,
        "title": clean_title,
        "created_at": created_at,
        "updated_at": updated_at,
    }
    if clean_note:
        frontmatter["note"] = clean_note
    for key, value in (extra_frontmatter or {}).items():
        if key in STANDARD_DRAFT_FRONTMATTER_KEYS:
            continue
        frontmatter[key] = value
    return frontmatter


def _build_draft_markdown(frontmatter: dict[str, Any], text: str) -> str:
    yaml_block = yaml_helper.dumps(frontmatter).strip()
    clean_text = _normalize_draft_text(text)
    content = f"---\n{yaml_block}\n---\n"
    if clean_text:
        content += f"\n{clean_text}\n"
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


def _generate_draft_id() -> str:
    return sanitize_draft_id(f"draft-{uuid4().hex[:12]}")


def _derive_draft_title(text: str) -> str:
    for line in (text or "").splitlines():
        clean_line = line.strip()
        if clean_line:
            return clean_line[:80]
    return "Untitled draft"


def _normalize_draft_text(text: str) -> str:
    return (text or "").lstrip("\n").rstrip()


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _resolve_draft_scope_context(project_name: str = "", context_id: str = "") -> tuple[str, str]:
    context = _get_context(context_id) if context_id else None
    resolved_project_name = project_name or (projects.get_context_project_name(context) if context else "") or ""
    resolved_context_id = getattr(context, "id", "") or (context_id or "")
    return resolved_project_name, resolved_context_id


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


def _load_draft_file(file_path: str, *, scope_key: str = "", project_name: str = "", context_id: str = "") -> dict[str, Any] | None:
    try:
        content = files.read_file(file_path)
    except FileNotFoundError:
        return None

    frontmatter, body, errors = split_frontmatter(content)
    if errors:
        return None

    raw_id = str(frontmatter.get("id") or "").strip()
    raw_title = str(frontmatter.get("title") or "").strip()
    if not raw_id or not raw_title:
        return None

    try:
        resolved_draft_id = sanitize_draft_id(raw_id)
    except ValueError:
        return None

    resolved_scope = get_draft_scope_key(scope_key, project_name, context_id)
    resolved_project_name, resolved_context_id = _resolve_draft_scope_context(project_name, context_id)
    note = str(frontmatter.get("note") or "").strip()
    created_at = str(frontmatter.get("created_at") or "").strip()
    updated_at = str(frontmatter.get("updated_at") or "").strip()
    extra_frontmatter = {key: value for key, value in frontmatter.items() if key not in STANDARD_DRAFT_FRONTMATTER_KEYS}
    directory_path = str(Path(file_path).parent)
    return {
        "id": resolved_draft_id,
        "title": raw_title,
        "note": note,
        "text": body.lstrip("\n").rstrip("\n"),
        "path": _normalize_client_path(file_path),
        "directory_path": _normalize_client_path(directory_path),
        "project_name": resolved_project_name,
        "agent_profile": "",
        "context_id": resolved_context_id,
        "scope_key": resolved_scope,
        "scope_label": get_draft_scope_label(resolved_scope, resolved_project_name, resolved_context_id),
        "frontmatter_extra": extra_frontmatter,
        "created_at": created_at,
        "updated_at": updated_at,
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


def _validate_draft_path(path: str, *, scope_key: str = "", project_name: str = "", context_id: str = "") -> str:
    draft_path = _to_abs_path(path)
    scope_root = get_draft_scope_directory(scope_key, project_name, context_id)
    if not files.is_in_dir(draft_path, scope_root):
        raise ValueError("Draft path is outside the selected scope")
    if not draft_path.endswith(DRAFT_FILE_SUFFIX):
        raise ValueError("Draft path must point to a .draft.md file")
    if not os.path.exists(draft_path):
        raise FileNotFoundError("Draft file not found")
    return draft_path


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


def _list_draft_files(scope_dir: str) -> list[str]:
    if not os.path.isdir(scope_dir):
        return []
    files_in_scope = [str(path) for path in Path(scope_dir).glob(f"*{DRAFT_FILE_SUFFIX}") if path.is_file()]
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


def _load_scope_drafts(scope_key: str = "", project_name: str = "", context_id: str = "") -> list[dict[str, Any]]:
    drafts: list[dict[str, Any]] = []
    scope_dir = get_draft_scope_directory(scope_key, project_name, context_id)
    for file_path in _list_draft_files(scope_dir):
        draft = _load_draft_file(file_path, scope_key=scope_key, project_name=project_name, context_id=context_id)
        if draft:
            drafts.append(draft)
    drafts.sort(key=lambda item: (item.get("updated_at", ""), item.get("title", ""), item["id"]), reverse=True)
    return drafts


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
