# Shortcuts

Scope-aware slash shortcuts for the Agent Zero chat composer.

## What it does
- Typing `/` in the chat input opens a popup of effective shortcuts for the current scope.
- Shortcuts are managed from a dedicated sidebar button, not buried in plugin settings.
- Shortcuts can be allocated by scope: global, project, agent, or project + agent.
- Multiple slash shortcuts can be used in one message.
- On send, matching shortcuts expand into their stored instruction text while preserving the rest of the user message.

## Management UX
- **Sidebar button:** opens the shortcut manager.
- **Manager modal:** create, edit, duplicate, delete, browse scope folder, and switch scope.
- **Plugin settings:** behavior only, such as popup size, compactness, and description visibility.

## Storage model
Shortcuts are stored as markdown-backed files with frontmatter in scoped `shortcuts/` directories.
Each shortcut file uses the `.shortcut.md` suffix.

## Example
Input:

`Please /summarize this and then /review it.`

Outgoing message:
- instruction text for `summarize`
- instruction text for `review`
- remaining prose with the slash tokens removed

## Keyboard controls
- **Arrow Up / Arrow Down**: move selection
- **Enter / Tab**: insert selected shortcut
- **Space**: insert selected shortcut followed by a space
- **Escape**: close popup

## Notes
- Keep the legacy `commands` plugin disabled while using this plugin to avoid overlapping slash UX.
- This plugin's differentiator is inline multi-command support in a single user message.
