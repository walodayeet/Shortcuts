import { callJsonApi } from "/js/api.js";
import { store as chatsStore } from "/components/sidebar/chats/chats-store.js";

export const PLUGIN_NAME = "slash_shortcuts";
export const SHORTCUTS_API_PATH = "/plugins/slash_shortcuts/slash_shortcuts";
export const ACCEPT_MARKER = "\u2060";
export const DEFAULT_CONFIG = {
  enabled: true,
  keep_popup_open_after_insert: false,
  show_descriptions: true,
  max_visible_items: 7,
  popup_offset_y: 14,
  popup_offset_x: 0,
  popup_width: 320,
  popup_height: 220,
  compact_mode: false,
  match_descriptions: true,
};

function titleCaseFromCommand(command) {
  return String(command || "")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unnamed";
}

function replaceAllLiteral(text, needle, replacement) {
  return String(text || "").split(needle).join(replacement);
}

function splitArguments(rawArguments) {
  const matches = String(rawArguments || "").match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

export function renderShortcutTemplate(instruction, rawArguments) {
  const template = String(instruction || "");
  const argumentsText = String(rawArguments || "").trim();
  let rendered = template;
  const tokens = splitArguments(argumentsText);

  for (let index = 0; index < 10; index += 1) {
    rendered = replaceAllLiteral(rendered, `$${index}`, tokens[index] || "");
  }

  rendered = replaceAllLiteral(rendered, "$ARGUMENTS", argumentsText);
  rendered = rendered.trim();

  if (argumentsText && !template.includes("$ARGUMENTS") && !/\$[0-9]/.test(template)) {
    const suffix = `Arguments: ${argumentsText}`;
    rendered = rendered ? `${rendered} ${suffix}` : suffix;
  }

  return rendered
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
}

export function normalizeShortcut(item, index = 0) {
  const command = String(item?.command || item?.name || item?.trigger || "").trim().replace(/^\/+/, "");
  const description = String(item?.description || "").trim();
  const argument_hint = String(item?.argument_hint || "").trim();
  const instruction = String(item?.instruction || item?.insert_text || item?.body || "").trim();
  const display_label = String(item?.display_label || item?.label || titleCaseFromCommand(command)).trim();
  if (!command || !instruction) return null;
  return {
    _id: item?.path || `${command}__${index}`,
    path: item?.path || "",
    command,
    description,
    argument_hint,
    instruction,
    display_label,
    scope_label: item?.scope_label || "",
    override_count: Number(item?.override_count || 0),
    override_scopes: Array.isArray(item?.override_scopes) ? item.override_scopes : [],
  };
}

async function loadScopedPluginConfig() {
  try {
    const contextId = chatsStore?.getSelectedChatId?.() || globalThis.getContext?.() || "";
    const scopeInfo = await callJsonApi(SHORTCUTS_API_PATH, {
      action: "scope_info",
      context_id: contextId,
    });
    const scope = scopeInfo?.scope || {};
    const response = await callJsonApi("plugins", {
      action: "get_config",
      plugin_name: PLUGIN_NAME,
      project_name: scope.project_name || "",
      agent_profile: scope.agent_profile || "",
    });
    return response?.data || {};
  } catch {
    return {};
  }
}

export async function loadPluginConfig() {
  const raw = await loadScopedPluginConfig();
  return { ...DEFAULT_CONFIG, ...(raw || {}) };
}

export async function loadEffectiveShortcuts() {
  const contextId = chatsStore?.getSelectedChatId?.() || globalThis.getContext?.() || "";
  const response = await callJsonApi(SHORTCUTS_API_PATH, {
    action: "list_effective",
    context_id: contextId,
  });
  const shortcuts = (Array.isArray(response?.shortcuts) ? response.shortcuts : [])
    .map((item, index) => normalizeShortcut(item, index))
    .filter(Boolean);
  return {
    shortcuts,
    scope: response?.scope || { project_name: "", agent_profile: "" },
  };
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseShortcutInvocations(message, commands) {
  const text = String(message ?? "");
  const commandMap = new Map((commands || []).map((item) => [String(item.command || "").toLowerCase(), item]));
  const matches = [];
  const marker = escapeRegExp(ACCEPT_MARKER);
  const regex = new RegExp(`(^|[\\s([{"'])\\/([A-Za-z0-9_-]+)(?:${marker})?(?:\\(([^)]*)\\))?(?=$|[\\s)\\]}\",.!?:;])`, "g");
  let match;

  while ((match = regex.exec(text)) !== null) {
    const key = String(match[2] || "").toLowerCase();
    const item = commandMap.get(key);
    if (!item) continue;

    const prefix = String(match[1] || "");
    const start = match.index + prefix.length;
    const end = regex.lastIndex;
    matches.push({
      ...item,
      raw_arguments: String(match[3] || "").trim(),
      start,
      end,
    });
  }

  return matches;
}

export function detectCommandsInMessage(message, commands) {
  return parseShortcutInvocations(message, commands);
}

export function buildExpandedMessage(message, matchedCommands) {
  const text = String(message ?? "");
  if (!matchedCommands?.length) return text.trim();

  const invocations = [...matchedCommands].sort((a, b) => a.start - b.start);
  const chunks = [];
  let cursor = 0;

  for (let index = 0; index < invocations.length; index += 1) {
    const invocation = invocations[index];
    const start = Number(invocation?.start ?? -1);
    const end = Number(invocation?.end ?? -1);
    if (start < 0 || end < start || start < cursor) continue;
    const chunk = text.slice(cursor, start);
    const normalizedChunk = chunk.replace(/\s+/g, " ").trim().toLowerCase();
    const isConnectorOnly = index > 0 && ["and", "then", "and then", "&", ",", ";"].includes(normalizedChunk);
    if (!isConnectorOnly) chunks.push(chunk);
    cursor = end;
  }
  chunks.push(text.slice(cursor));

  const base = chunks.join("")
    .split(ACCEPT_MARKER).join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const instructionText = invocations
    .map((item) => renderShortcutTemplate(item.instruction, item.raw_arguments))
    .filter(Boolean)
    .join(" ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();

  if (!instructionText) return base;
  if (!base) return instructionText;
  return `${instructionText} ${base}`
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
}
