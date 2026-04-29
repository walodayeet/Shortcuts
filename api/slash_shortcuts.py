from __future__ import annotations

from helpers.api import ApiHandler, Request, Response
from usr.plugins.slash_shortcuts.helpers import slash_shortcuts as shortcuts_helper


class SlashShortcuts(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        action = str(input.get("action", "") or "").strip()

        if action == "list_effective":
            return self._list_effective(input)
        if action == "list_scope":
            return self._list_scope(input)
        if action == "get":
            return self._get(input)
        if action == "save":
            return self._save(input)
        if action == "delete":
            return self._delete(input)
        if action == "duplicate":
            return self._duplicate(input)
        if action == "scope_info":
            return self._scope_info(input)
        if action == "list_drafts":
            return self._list_drafts(input)
        if action == "get_draft":
            return self._get_draft(input)
        if action == "save_draft":
            return self._save_draft(input)
        if action == "delete_draft":
            return self._delete_draft(input)
        if action == "draft_scope_info":
            return self._draft_scope_info(input)

        return Response(status=400, response=f"Unknown action: {action}")

    def _list_effective(self, input: dict) -> dict | Response:
        explicit_project = str(input.get("project_name", "") or "")
        explicit_agent = str(input.get("agent_profile", "") or "")
        context_scope = shortcuts_helper.get_context_scope(str(input.get("context_id", "") or ""))
        project_name = explicit_project if "project_name" in input else context_scope["project_name"]
        agent_profile = explicit_agent if "agent_profile" in input else context_scope["agent_profile"]
        shortcuts, scope = shortcuts_helper.list_effective_shortcuts(
            project_name=project_name,
            agent_profile=agent_profile,
        )
        return {"ok": True, "shortcuts": shortcuts, "scope": scope}

    def _list_scope(self, input: dict) -> dict | Response:
        try:
            shortcuts, scope = shortcuts_helper.list_scope_shortcuts(
                project_name=str(input.get("project_name", "") or ""),
                agent_profile=str(input.get("agent_profile", "") or ""),
            )
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "shortcuts": shortcuts, "scope": scope}

    def _get(self, input: dict) -> dict | Response:
        path = str(input.get("path", "") or "")
        if not path:
            return Response(status=400, response="Missing path")
        try:
            shortcut = shortcuts_helper.get_shortcut(
                path,
                project_name=str(input.get("project_name", "") or ""),
                agent_profile=str(input.get("agent_profile", "") or ""),
            )
        except FileNotFoundError:
            return Response(status=404, response="Shortcut not found")
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "shortcut": shortcut}

    def _save(self, input: dict) -> dict | Response:
        try:
            shortcut = shortcuts_helper.save_shortcut(
                project_name=str(input.get("project_name", "") or ""),
                agent_profile=str(input.get("agent_profile", "") or ""),
                existing_path=str(input.get("existing_path", "") or ""),
                name=str(input.get("name", "") or ""),
                description=str(input.get("description", "") or ""),
                display_label=str(input.get("display_label", "") or ""),
                argument_hint=str(input.get("argument_hint", "") or ""),
                instruction=str(input.get("instruction", "") or ""),
                extra_frontmatter=self._get_extra_frontmatter(input),
            )
        except FileExistsError as error:
            return Response(status=409, response=str(error))
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "shortcut": shortcut}

    def _delete(self, input: dict) -> dict | Response:
        path = str(input.get("path", "") or "")
        if not path:
            return Response(status=400, response="Missing path")
        try:
            shortcuts_helper.delete_shortcut(
                path,
                project_name=str(input.get("project_name", "") or ""),
                agent_profile=str(input.get("agent_profile", "") or ""),
            )
        except FileNotFoundError:
            return Response(status=404, response="Shortcut not found")
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True}

    def _duplicate(self, input: dict) -> dict | Response:
        path = str(input.get("path", "") or "")
        if not path:
            return Response(status=400, response="Missing path")
        try:
            shortcut = shortcuts_helper.duplicate_shortcut(
                path,
                project_name=str(input.get("project_name", "") or ""),
                agent_profile=str(input.get("agent_profile", "") or ""),
            )
        except FileNotFoundError:
            return Response(status=404, response="Shortcut not found")
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "shortcut": shortcut}

    def _scope_info(self, input: dict) -> dict | Response:
        explicit_project = str(input.get("project_name", "") or "")
        explicit_agent = str(input.get("agent_profile", "") or "")
        context_scope = shortcuts_helper.get_context_scope(str(input.get("context_id", "") or ""))
        project_name = explicit_project if "project_name" in input else context_scope["project_name"]
        agent_profile = explicit_agent if "agent_profile" in input else context_scope["agent_profile"]
        try:
            scope = shortcuts_helper.get_scope_payload(
                project_name=project_name,
                agent_profile=agent_profile,
                ensure_directory=bool(input.get("ensure_directory", False)),
            )
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "scope": shortcuts_helper.strip_private_scope(scope), "context_scope": context_scope}

    def _list_drafts(self, input: dict) -> dict | Response:
        try:
            drafts, scope = shortcuts_helper.list_scope_drafts(
                scope_key=str(input.get("scope_key", "") or ""),
                project_name=str(input.get("project_name", "") or ""),
                context_id=str(input.get("context_id", "") or ""),
            )
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "drafts": drafts, "scope": scope}

    def _get_draft(self, input: dict) -> dict | Response:
        path = str(input.get("path", "") or "")
        if not path:
            return Response(status=400, response="Missing path")
        try:
            draft = shortcuts_helper.get_draft(
                path,
                scope_key=str(input.get("scope_key", "") or ""),
                project_name=str(input.get("project_name", "") or ""),
                context_id=str(input.get("context_id", "") or ""),
            )
        except FileNotFoundError:
            return Response(status=404, response="Draft not found")
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "draft": draft}

    def _save_draft(self, input: dict) -> dict | Response:
        try:
            draft = shortcuts_helper.save_draft(
                scope_key=str(input.get("scope_key", "") or ""),
                project_name=str(input.get("project_name", "") or ""),
                context_id=str(input.get("context_id", "") or ""),
                existing_path=str(input.get("existing_path", "") or ""),
                draft_id=str(input.get("draft_id", "") or ""),
                title=str(input.get("title", "") or ""),
                note=str(input.get("note", "") or ""),
                text=str(input.get("text", "") or ""),
                extra_frontmatter=self._get_extra_frontmatter(input),
            )
        except FileExistsError as error:
            return Response(status=409, response=str(error))
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "draft": draft}

    def _delete_draft(self, input: dict) -> dict | Response:
        path = str(input.get("path", "") or "")
        if not path:
            return Response(status=400, response="Missing path")
        try:
            shortcuts_helper.delete_draft(
                path,
                scope_key=str(input.get("scope_key", "") or ""),
                project_name=str(input.get("project_name", "") or ""),
                context_id=str(input.get("context_id", "") or ""),
            )
        except FileNotFoundError:
            return Response(status=404, response="Draft not found")
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True}

    def _draft_scope_info(self, input: dict) -> dict | Response:
        context_id = str(input.get("context_id", "") or "")
        context_scope = shortcuts_helper.get_context_scope(context_id)
        explicit_scope_key = str(input.get("scope_key", "") or "")
        explicit_project = str(input.get("project_name", "") or "")
        project_name = explicit_project if "project_name" in input else context_scope["project_name"]
        try:
            scope = shortcuts_helper.get_draft_scope_payload(
                scope_key=explicit_scope_key,
                project_name=project_name,
                context_id=context_id,
                ensure_directory=bool(input.get("ensure_directory", False)),
            )
        except ValueError as error:
            return Response(status=400, response=str(error))
        return {"ok": True, "scope": shortcuts_helper.strip_private_scope(scope), "context_scope": context_scope}

    def _get_extra_frontmatter(self, input: dict) -> dict:
        extra_frontmatter = input.get("extra_frontmatter", {})
        if extra_frontmatter is None:
            return {}
        if not isinstance(extra_frontmatter, dict):
            raise ValueError("extra_frontmatter must be an object")
        return extra_frontmatter
