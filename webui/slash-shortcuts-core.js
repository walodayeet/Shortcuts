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
  drafts_popup_width: 520,
  drafts_popup_height: 420,
  compact_mode: false,
  match_descriptions: true,
};

const MAX_NESTED_EXPANSION_DEPTH = 8;

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

function normalizeExpandedText(text) {
  return String(text ?? "")
    .split(ACCEPT_MARKER).join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
}

function isCommandCharacter(char) {
  return /[A-Za-z0-9_-]/.test(String(char || ""));
}

function isPrefixBoundary(text, slashIndex) {
  if (slashIndex <= 0) return true;
  return /[\s([{"']/.test(text.charAt(slashIndex - 1));
}

function isSuffixBoundary(text, index) {
  if (index >= text.length) return true;
  return /[\s)\]}\",.!?:;]/.test(text.charAt(index));
}

function readBalancedParentheses(text, startIndex) {
  if (text.charAt(startIndex) !== "(") return null;

  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = "";
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(startIndex + 1, index),
          end: index + 1,
        };
      }
    }
  }

  return null;
}

function getTopLevelInvocations(matchedCommands) {
  const sorted = [...(matchedCommands || [])].sort((a, b) => {
    const startDelta = Number(a?.start ?? -1) - Number(b?.start ?? -1);
    if (startDelta !== 0) return startDelta;
    return Number(b?.end ?? -1) - Number(a?.end ?? -1);
  });

  const topLevel = [];
  const stack = [];

  for (const invocation of sorted) {
    const start = Number(invocation?.start ?? -1);
    const end = Number(invocation?.end ?? -1);
    if (start < 0 || end < start) continue;

    while (stack.length && start >= Number(stack[stack.length - 1]?.end ?? -1)) {
      stack.pop();
    }

    if (!stack.length) {
      topLevel.push(invocation);
    }

    stack.push(invocation);
  }

  return topLevel;
}

function deriveAvailableCommands(matchedCommands) {
  return Array.from(new Map((matchedCommands || [])
    .filter((item) => item?.command)
    .map((item) => [String(item.command || "").toLowerCase(), item])).values());
}

function expandNestedArguments(rawArguments, availableCommands, depth = 0) {
  const text = String(rawArguments || "").trim();
  if (!text || depth >= MAX_NESTED_EXPANSION_DEPTH) return text;

  const nestedMatches = detectCommandsInMessage(text, availableCommands);
  if (!nestedMatches.length) return text;

  return buildExpandedMessageInternal(text, nestedMatches, availableCommands, depth + 1);
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

function parseShortcutInvocations(message, commands, baseOffset = 0) {
  const text = String(message ?? "");
  const commandMap = new Map((commands || []).map((item) => [String(item.command || "").toLowerCase(), item]));
  const matches = [];

  let index = 0;
  while (index < text.length) {
    const slashIndex = text.indexOf("/", index);
    if (slashIndex === -1) break;

    if (!isPrefixBoundary(text, slashIndex)) {
      index = slashIndex + 1;
      continue;
    }

    let cursor = slashIndex + 1;
    let command = "";
    while (cursor < text.length && isCommandCharacter(text.charAt(cursor))) {
      command += text.charAt(cursor);
      cursor += 1;
    }

    if (!command) {
      index = slashIndex + 1;
      continue;
    }

    if (text.startsWith(ACCEPT_MARKER, cursor)) {
      cursor += ACCEPT_MARKER.length;
    }

    const item = commandMap.get(command.toLowerCase());
    if (!item) {
      index = slashIndex + 1;
      continue;
    }

    let rawArguments = "";
    if (text.charAt(cursor) === "(") {
      const parsed = readBalancedParentheses(text, cursor);
      if (!parsed) {
        index = slashIndex + 1;
        continue;
      }
      rawArguments = String(parsed.content || "").trim();
      const nestedMatches = parseShortcutInvocations(parsed.content, commands, baseOffset + cursor + 1);
      matches.push({
        ...item,
        raw_arguments: rawArguments,
        start: baseOffset + slashIndex,
        end: baseOffset + parsed.end,
      });
      matches.push(...nestedMatches);
      index = parsed.end;
      continue;
    }

    if (!isSuffixBoundary(text, cursor)) {
      index = slashIndex + 1;
      continue;
    }

    matches.push({
      ...item,
      raw_arguments: rawArguments,
      start: baseOffset + slashIndex,
      end: baseOffset + cursor,
    });
    index = cursor;
  }

  return matches;
}

export function detectCommandsInMessage(message, commands) {
  return parseShortcutInvocations(message, commands);
}

function buildExpandedMessageInternal(message, matchedCommands, availableCommands, depth = 0) {
  const text = String(message ?? "");
  if (!matchedCommands?.length) return normalizeExpandedText(text);

  const invocations = getTopLevelInvocations(matchedCommands);
  if (!invocations.length) return normalizeExpandedText(text);

  const parts = [];
  let cursor = 0;

  for (const invocation of invocations) {
    const start = Number(invocation?.start ?? -1);
    const end = Number(invocation?.end ?? -1);
    if (start < 0 || end < start || start < cursor) continue;

    parts.push(text.slice(cursor, start));

    const expandedArguments = expandNestedArguments(invocation.raw_arguments, availableCommands, depth);
    const renderedInstruction = renderShortcutTemplate(invocation.instruction, expandedArguments);
    if (renderedInstruction) parts.push(renderedInstruction);

    cursor = end;
  }

  parts.push(text.slice(cursor));
  return normalizeExpandedText(parts.join(""));
}

export function buildExpandedMessage(message, matchedCommands) {
  return buildExpandedMessageInternal(message, matchedCommands, deriveAvailableCommands(matchedCommands), 0);
}
