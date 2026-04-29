import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { toastFrontendError, toastFrontendSuccess } from "/components/notifications/notification-store.js";
import { store as chatsStore } from "/components/sidebar/chats/chats-store.js";
import { store as fileBrowserStore } from "/components/modals/file-browser/file-browser-store.js";

const API_PATH = "/plugins/slash_shortcuts/slash_shortcuts";
const MAIN_MODAL_PATH = "/plugins/slash_shortcuts/webui/main.html";
const EDITOR_MODAL_PATH = "/plugins/slash_shortcuts/webui/editor.html";

function createEmptyEditor() {
  return {
    mode: "create",
    existingPath: "",
    path: "",
    name: "",
    description: "",
    displayLabel: "",
    argumentHint: "",
    instruction: "",
    extraFrontmatter: {},
  };
}

function safeStringify(value) {
  try { return JSON.stringify(value ?? {}); } catch { return ""; }
}

function sanitizeShortcutName(rawName) {
  return (rawName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function buildDefaultInstruction() {
  return "Write the reusable instruction text inserted when this shortcut is used.\n\n$ARGUMENTS";
}

function firstMeaningfulLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function buildSuggestedShortcutName(instruction, fallbackName = "") {
  const preferredSource = String(fallbackName || "").trim() || firstMeaningfulLine(instruction);
  const compact = preferredSource
    .replace(/^\/+/, "")
    .replace(/[$]ARGUMENTS|[$][0-9]/g, " ")
    .replace(/[^A-Za-z0-9 _-]+/g, " ")
    .trim();
  const words = compact.match(/[A-Za-z0-9_-]+/g) || [];
  const candidate = words.slice(0, 6).join("-");
  return candidate ? sanitizeShortcutName(candidate) : "";
}

function notifyError(message) { void toastFrontendError(message, "Shortcuts"); }
function notifySuccess(message) { void toastFrontendSuccess(message, "Shortcuts"); }
function emitShortcutsUpdated() { window.dispatchEvent(new CustomEvent("slash_shortcuts:updated")); }
function getActiveProjectName() { return String(chatsStore?.selectedContext?.project?.name || "").trim(); }

const model = {
  loading: false,
  saving: false,
  projects: [],
  agentProfiles: [],
  projectName: "",
  agentProfile: "",
  scope: null,
  contextScope: { project_name: "", agent_profile: "" },
  shortcuts: [],
  pendingScope: null,
  pendingCreate: null,
  editor: createEmptyEditor(),
  editorSnapshot: "",

  get selectedScopeLabel() { return this.scope?.scope_label || "Global"; },
  get selectedScopeDirectory() { return this.scope?.directory_path || ""; },
  get hasShortcuts() { return (this.shortcuts || []).length > 0; },
  get editorTitle() { return this.editor.mode === "edit" ? "Edit Shortcut" : "Create Shortcut"; },
  get editorDirty() { return this._serializeEditor() !== this.editorSnapshot; },

  openManager(options = {}) {
    const hasExplicitScope = Object.prototype.hasOwnProperty.call(options, "projectName") || Object.prototype.hasOwnProperty.call(options, "agentProfile");
    this.pendingScope = hasExplicitScope ? { projectName: options.projectName || "", agentProfile: options.agentProfile || "" } : null;
    const shouldOpenEditor = !!(
      options.openEditor
      || options.prefillName
      || options.prefillInstruction
      || options.prefillDescription
      || options.prefillDisplayLabel
      || options.prefillArgumentHint
    );
    this.pendingCreate = shouldOpenEditor ? {
      name: options.prefillName || "",
      instruction: options.prefillInstruction || "",
      description: options.prefillDescription || "",
      displayLabel: options.prefillDisplayLabel || "",
      argumentHint: options.prefillArgumentHint || "",
      ...(Object.prototype.hasOwnProperty.call(options, "projectName") ? { projectName: options.projectName || "" } : {}),
    } : null;
    return window.openModal?.(MAIN_MODAL_PATH);
  },

  async onOpen() {
    await Promise.all([this.loadProjects()]);
    try {
      await this.resolveInitialScope();
      await this.loadShortcuts();
    } catch (error) {
      console.error("Failed to initialize shortcut manager:", error);
      this.scope = null;
      this.shortcuts = [];
      notifyError(error?.message || "Failed to open the shortcut manager.");
    }
    if (this.pendingCreate) {
      const pendingCreate = { ...this.pendingCreate };
      this.pendingCreate = null;
      await this.openCreateShortcut(pendingCreate);
    }
  },

  cleanup() {
    this.loading = false;
    this.saving = false;
    this.projects = [];
    this.agentProfiles = [];
    this.projectName = "";
    this.agentProfile = "";
    this.scope = null;
    this.contextScope = { project_name: "", agent_profile: "" };
    this.shortcuts = [];
    this.pendingScope = null;
    this.pendingCreate = null;
    this.resetEditor();
  },

  async loadProjects() {
    try {
      const response = await callJsonApi("projects", { action: "list_options" });
      this.projects = Array.isArray(response?.data) ? response.data : [];
    } catch {
      this.projects = [];
    }
  },

  async loadAgentProfiles() {
    try {
      const response = await callJsonApi("agents", { action: "list" });
      this.agentProfiles = Array.isArray(response?.data) ? response.data : [];
    } catch {
      this.agentProfiles = [];
    }
  },

  normalizeProject(projectName) {
    if (!projectName) return "";
    return (this.projects || []).some((project) => project?.key === projectName) ? projectName : "";
  },

  normalizeAgentProfile(agentProfile) {
    if (!agentProfile) return "";
    return (this.agentProfiles || []).some((profile) => profile?.key === agentProfile) ? agentProfile : "";
  },

  async resolveInitialScope() {
    const contextId = chatsStore?.getSelectedChatId?.() || globalThis.getContext?.() || "";
    const projectName = getActiveProjectName();
    const scopeInfo = await callJsonApi(API_PATH, {
      action: "scope_info",
      context_id: contextId,
      project_name: projectName,
    });
    this.contextScope = scopeInfo?.context_scope || { project_name: "", agent_profile: "" };
    const preferredScope = this.pendingScope || scopeInfo?.scope || {};
    this.projectName = this.normalizeProject(preferredScope.project_name || projectName || "");
    this.agentProfile = "";
    this.pendingScope = null;
  },

  async loadShortcuts() {
    this.loading = true;
    try {
      const response = await callJsonApi(API_PATH, {
        action: "list_scope",
        project_name: this.projectName || "",
      });
      this.shortcuts = Array.isArray(response?.shortcuts) ? response.shortcuts : [];
      this.scope = response?.scope || null;
    } catch (error) {
      console.error("Failed to load shortcuts:", error);
      this.shortcuts = [];
      this.scope = null;
      notifyError(error?.message || "Failed to load shortcuts.");
    } finally {
      this.loading = false;
    }
  },

  async refresh() { await this.loadShortcuts(); },

  async onScopeChanged() {
    this.projectName = this.normalizeProject(this.projectName);
    this.agentProfile = "";
    await this.loadShortcuts();
  },

  overrideBadgeLabel(shortcut) {
    const count = Number(shortcut?.override_count || 0);
    if (!count) return "";
    if (count === 1) return `Overrides ${shortcut.override_scopes[0]}`;
    return `Overrides ${count} lower scopes`;
  },

  async browseScopeFolder() {
    try {
      const response = await callJsonApi(API_PATH, {
        action: "scope_info",
        project_name: this.projectName || "",
        ensure_directory: true,
      });
      if (response?.scope?.directory_path) await fileBrowserStore.open(response.scope.directory_path);
    } catch (error) {
      console.error("Failed to open scope folder:", error);
      notifyError(error?.message || "Failed to open scope folder.");
    }
  },

  async openCreateShortcut(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, "projectName")) this.projectName = this.normalizeProject(options.projectName || "");
    this.agentProfile = "";
    if (Object.prototype.hasOwnProperty.call(options, "projectName")) await this.loadShortcuts();
    const suggestedName = buildSuggestedShortcutName(options.instruction || "", options.name || "");
    this.editor = {
      ...createEmptyEditor(),
      mode: "create",
      name: suggestedName,
      description: String(options.description || ""),
      displayLabel: String(options.displayLabel || ""),
      argumentHint: String(options.argumentHint || ""),
      instruction: String(options.instruction || "") || buildDefaultInstruction(),
    };
    this.editorSnapshot = this._serializeEditor();
    await this.openEditorModal();
  },

  async openEditShortcut(shortcut) {
    if (!shortcut?.path) return;
    try {
      const response = await callJsonApi(API_PATH, {
        action: "get",
        path: shortcut.path,
        project_name: this.projectName || "",
      });
      const loaded = response?.shortcut || shortcut;
      this.editor = {
        mode: "edit",
        existingPath: loaded.path || "",
        path: loaded.path || "",
        name: loaded.command || loaded.name || "",
        description: loaded.description || "",
        displayLabel: loaded.display_label || "",
        argumentHint: loaded.argument_hint || "",
        instruction: loaded.instruction || "",
        extraFrontmatter: loaded.frontmatter_extra || {},
      };
      this.editorSnapshot = this._serializeEditor();
      await this.openEditorModal();
    } catch (error) {
      console.error("Failed to load shortcut:", error);
      notifyError(error?.message || "Failed to load shortcut.");
    }
  },

  async duplicateShortcut(shortcut) {
    if (!shortcut?.path) return;
    try {
      const response = await callJsonApi(API_PATH, {
        action: "duplicate",
        path: shortcut.path,
        project_name: this.projectName || "",
      });
      await this.loadShortcuts();
      emitShortcutsUpdated();
      notifySuccess(`Duplicated /${response?.shortcut?.command || shortcut.command}`);
      if (response?.shortcut) await this.openEditShortcut(response.shortcut);
    } catch (error) {
      console.error("Failed to duplicate shortcut:", error);
      notifyError(error?.message || "Failed to duplicate shortcut.");
    }
  },

  async deleteShortcut(shortcut) {
    if (!shortcut?.path) return;
    try {
      await callJsonApi(API_PATH, {
        action: "delete",
        path: shortcut.path,
        project_name: this.projectName || "",
      });
      await this.loadShortcuts();
      emitShortcutsUpdated();
      notifySuccess(`Deleted /${shortcut.command}`);
    } catch (error) {
      console.error("Failed to delete shortcut:", error);
      notifyError(error?.message || "Failed to delete shortcut.");
    }
  },

  async openEditorModal() {
    await window.openModal?.(EDITOR_MODAL_PATH, () => this.confirmCloseEditor());
    this.resetEditor();
  },

  confirmCloseEditor() {
    if (!this.editorDirty) return true;
    return window.confirm("Discard unsaved shortcut changes?");
  },

  async closeEditor() { await window.closeModal?.(EDITOR_MODAL_PATH); },

  async saveEditor() {
    this.saving = true;
    try {
      const response = await callJsonApi(API_PATH, {
        action: "save",
        project_name: this.projectName || "",
        existing_path: this.editor.existingPath || "",
        name: this.editor.name || "",
        description: this.editor.description || "",
        display_label: this.editor.displayLabel || "",
        argument_hint: this.editor.argumentHint || "",
        instruction: this.editor.instruction || "",
        extra_frontmatter: this.editor.extraFrontmatter || {},
      });
      this.editor.path = response?.shortcut?.path || "";
      this.editor.existingPath = response?.shortcut?.path || "";
      this.editorSnapshot = this._serializeEditor();
      await this.loadShortcuts();
      emitShortcutsUpdated();
      notifySuccess(`${this.editor.mode === "edit" ? "Updated" : "Saved"} /${response?.shortcut?.command || this.editor.name}`);
      await window.closeModal?.(EDITOR_MODAL_PATH);
    } catch (error) {
      console.error("Failed to save shortcut:", error);
      notifyError(error?.message || "Failed to save shortcut.");
    } finally {
      this.saving = false;
    }
  },

  resetEditor() {
    this.editor = createEmptyEditor();
    this.editorSnapshot = this._serializeEditor();
  },

  _serializeEditor() {
    return safeStringify({
      existingPath: this.editor.existingPath || "",
      name: this.editor.name || "",
      description: this.editor.description || "",
      displayLabel: this.editor.displayLabel || "",
      argumentHint: this.editor.argumentHint || "",
      instruction: this.editor.instruction || "",
      extraFrontmatter: this.editor.extraFrontmatter || {},
    });
  },
};

export const store = createStore("slashShortcutsManager", model);
