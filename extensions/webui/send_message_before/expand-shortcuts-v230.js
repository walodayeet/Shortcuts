import { buildExpandedMessage, detectCommandsInMessage, loadEffectiveShortcuts, loadPluginConfig } from "/plugins/slash_shortcuts/webui/slash-shortcuts-core.js?v=2.3.7";

export default async function expandSlashCommands(sendCtx) {
  if (!sendCtx || typeof sendCtx.message !== "string") return;
  const original = String(sendCtx.message || "").trim();
  if (!original) return;
  const config = await loadPluginConfig();
  if (!config?.enabled) return;
  const { shortcuts } = await loadEffectiveShortcuts();
  if (!Array.isArray(shortcuts) || shortcuts.length === 0) return;
  const matched = detectCommandsInMessage(original, shortcuts);
  if (!matched.length) return;
  sendCtx.message = buildExpandedMessage(sendCtx.message, matched);
}
