import { ACCEPT_MARKER, buildExpandedMessage, detectCommandsInMessage, loadEffectiveShortcuts, loadPluginConfig } from "/plugins/slash_shortcuts/webui/slash-shortcuts-core.js?v=2.4.8";

export default async function expandSlashCommands(sendCtx) {
  if (!sendCtx || typeof sendCtx.message !== "string") return;
  const original = String(sendCtx.message || "").trim();
  if (!original) return;
  if (!original.includes("/") && !original.includes(ACCEPT_MARKER)) return;

  const slashShortcutsStore = window.Alpine?.store?.("slashShortcuts");
  let config = slashShortcutsStore?.config || null;
  let shortcuts = Array.isArray(slashShortcutsStore?.commands) ? slashShortcutsStore.commands : [];

  if (!config || typeof config.enabled === "undefined") {
    config = await loadPluginConfig();
  }
  if (!config?.enabled) return;

  if (!shortcuts.length) {
    const loaded = await loadEffectiveShortcuts();
    shortcuts = Array.isArray(loaded?.shortcuts) ? loaded.shortcuts : [];
  }
  if (!shortcuts.length) return;

  const matched = detectCommandsInMessage(original, shortcuts);
  if (!matched.length) return;
  sendCtx.message = buildExpandedMessage(sendCtx.message, matched);
}
