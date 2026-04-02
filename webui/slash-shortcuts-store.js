import { createStore } from "/js/AlpineStore.js";
import { toastFrontendError, toastFrontendInfo, toastFrontendSuccess } from "/components/notifications/notification-store.js";
import { store as chatsStore } from "/components/sidebar/chats/chats-store.js";
import { ACCEPT_MARKER, DEFAULT_CONFIG, loadEffectiveShortcuts, loadPluginConfig } from "/plugins/slash_shortcuts/webui/slash-shortcuts-core.js?v=2.4.7";
import { store as slashShortcutsManagerStore } from "/plugins/slash_shortcuts/webui/slash-shortcuts-manager-store.js?v=2.4.7";

const API_PATH = "/api/plugins/slash_shortcuts/slash_shortcuts";
const DRAFT_SCOPE_STORAGE_KEY = "slashShortcutsDraftScopeKey";
const DRAFT_SCOPE_OPTIONS = [
  { key: "chat", label: "Chat" },
  { key: "project", label: "Project" },
  { key: "global", label: "Global" },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function countWords(text) {
  const matches = String(text || "").trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function normalizeDraftScopeKey(scopeKey) {
  const normalized = String(scopeKey || "").trim().toLowerCase();
  return ["global", "project", "chat"].includes(normalized) ? normalized : "";
}

function getContextId() {
  return chatsStore?.getSelectedChatId?.() || globalThis.getContext?.() || "";
}

async function callDraftApi(body = {}) {
  const response = await fetch(API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const contentType = String(response.headers.get("content-type") || "");
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { ok: response.ok, error: await response.text() };
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || payload?.message || `Draft request failed (${response.status})`);
  }
  return payload;
}

function truncateDraftPreview(text, limit = 220) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function parseDraftTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareDraftItemsByUpdatedTime(a, b) {
  const aUpdated = parseDraftTimestamp(a?.updated_at) || parseDraftTimestamp(a?.created_at);
  const bUpdated = parseDraftTimestamp(b?.updated_at) || parseDraftTimestamp(b?.created_at);
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;

  const aCreated = parseDraftTimestamp(a?.created_at);
  const bCreated = parseDraftTimestamp(b?.created_at);
  if (aCreated !== bCreated) return bCreated - aCreated;

  const aTitle = String(a?.title || a?.label || a?.id || "").toLowerCase();
  const bTitle = String(b?.title || b?.label || b?.id || "").toLowerCase();
  if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);

  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function mapDraftToPanelItem(draft) {
  const text = String(draft?.text || "").trim();
  const title = String(draft?.title || "").trim() || "Untitled draft";
  const scopeLabel = String(draft?.scope_label || "").trim() || "Draft";
  const explicitNote = String(draft?.note || "").trim();
  return {
    ...draft,
    id: draft?.id || draft?.path || title,
    kind: "draft",
    label: title,
    text,
    scope_label: scopeLabel,
    note: explicitNote || `${scopeLabel} draft. It never auto-sends. Restore it into the composer to use it.`,
    excerpt: truncateDraftPreview(text),
    wordCount: countWords(text),
  };
}

function readStoredDraftScopeKey() {
  try {
    return normalizeDraftScopeKey(window.localStorage?.getItem(DRAFT_SCOPE_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

function writeStoredDraftScopeKey(scopeKey) {
  const normalized = normalizeDraftScopeKey(scopeKey);
  if (!normalized) return;
  try {
    window.localStorage?.setItem(DRAFT_SCOPE_STORAGE_KEY, normalized);
  } catch {}
}

export const store = createStore("slashShortcuts", {
  config: { ...DEFAULT_CONFIG },
  visible: false,
  popupStyle: "left:-9999px;top:-9999px;",
  commands: [],
  filteredCommands: [],
  selectedIndex: 0,
  activeToken: null,
  inputEl: null,
  bound: false,
  refreshTimer: null,
  rafHandle: null,
  blurCloseTimer: null,
  mobileWatchTimer: null,
  isInputFocused: false,
  lastViewportHeight: 0,
  cleanupFns: [],
  pinnedDraft: null,
  drafts: [],
  draftScopeKey: "",
  draftScope: null,
  draftContextScope: { project_name: "", agent_profile: "" },
  draftsLoading: false,
  draftSaving: false,
  popupView: "shortcuts",
  manualPopup: false,

  init() {},
  get showDescriptions() { return !!this.config?.show_descriptions; },
  get compactMode() { return !!this.config?.compact_mode; },
  get isDraftsView() { return this.popupView === "drafts"; },
  get isShortcutsView() { return this.popupView !== "drafts"; },
  get canUseProjectDrafts() { return !!(this.draftContextScope?.project_name || this.draftScope?.project_name); },
  get canUseChatDrafts() { return !!(this.draftScope?.context_id || this.getCurrentContextId()); },
  get availableDraftScopes() {
    return DRAFT_SCOPE_OPTIONS.map((option) => ({
      ...option,
      enabled: option.key === "global" || (option.key === "project" ? this.canUseProjectDrafts : this.canUseChatDrafts),
    }));
  },
  get currentQueryDisplay() {
    if (this.isDraftsView) {
      const label = this.draftScope?.scope_label || "Draft";
      return `${label} drafts are persistent and never auto-send.`;
    }
    const q = this.activeToken?.query || "";
    if (q) return `/${q}`;
    return this.manualPopup ? "Browse shortcuts" : "/";
  },
  get composerHasText() { return !!this.getCurrentComposerText().trim(); },
  get hasPinnedDraft() { return this.draftPanelCount > 0; },
  get pinnedDraftLabel() { return `${this.draftScope?.scope_label || "Draft"} Drafts`; },
  get pinnedDraftWordCount() { return this.draftPanelItems.reduce((total, item) => total + Number(item.wordCount || 0), 0); },
  get draftScopeLabel() { return this.draftScope?.scope_label || "Draft"; },
  get draftScopePath() { return this.draftScope?.directory_path || ""; },
  get draftPanelItems() {
    return (this.drafts || [])
      .map((draft) => mapDraftToPanelItem(draft))
      .sort(compareDraftItemsByUpdatedTime);
  },
  get draftPanelCount() { return this.draftPanelItems.length; },
  get hasDraftPanelItems() { return this.draftPanelCount > 0; },

  async mount() {
    if (this.bound) return;
    this.bound = true;
    await this.reloadAll();
    this.bindInput();
    this.reposition();
    const onUpdated = async () => {
      await this.reloadAll();
      this.handleInputLikeEvent();
    };
    window.addEventListener("slash_shortcuts:updated", onUpdated);
    this.cleanupFns.push(() => window.removeEventListener("slash_shortcuts:updated", onUpdated));
  },

  async reloadAll() {
    try {
      const [config, shortcutsResult] = await Promise.all([loadPluginConfig(), loadEffectiveShortcuts()]);
      this.config = config;
      this.commands = shortcutsResult.shortcuts || [];
    } catch (error) {
      this.config = { ...DEFAULT_CONFIG };
      this.commands = [];
      toastFrontendError(error?.message || "Failed to load Shortcuts config", "Shortcuts");
    }

    try {
      await this.initializeDraftScope();
    } catch (error) {
      console.error("Failed to initialize drafts:", error);
      this.drafts = [];
      this.draftScope = null;
      this.draftContextScope = { project_name: "", agent_profile: "" };
    }
  },

  getCurrentContextId() {
    return getContextId();
  },

  getDefaultDraftScopeKey() {
    if (this.getCurrentContextId()) return "chat";
    if (this.draftContextScope?.project_name || this.draftScope?.project_name) return "project";
    return "global";
  },

  getDraftRequestScope(scopeKey = this.draftScopeKey) {
    const normalized = normalizeDraftScopeKey(scopeKey) || this.getDefaultDraftScopeKey();
    const payload = { scope_key: normalized };
    const contextId = this.getCurrentContextId();
    if (contextId) payload.context_id = contextId;
    return payload;
  },

  getDraftPayloadFromItem(item = null) {
    const payload = this.getDraftRequestScope(item?.scope_key || this.draftScopeKey || this.getDefaultDraftScopeKey());
    if (item?.path) payload.path = item.path;
    if (item?.project_name) payload.project_name = item.project_name;
    if (item?.context_id) payload.context_id = item.context_id;
    return payload;
  },

  async initializeDraftScope(options = {}) {
    const { force = false, preferredScopeKey = "" } = options;
    if (!force && this.draftScope && this.draftScopeKey) return;

    const candidates = [];
    const preferred = normalizeDraftScopeKey(preferredScopeKey || this.draftScopeKey || readStoredDraftScopeKey());
    if (preferred) candidates.push(preferred);
    for (const candidate of [this.getDefaultDraftScopeKey(), "chat", "project", "global"]) {
      const normalized = normalizeDraftScopeKey(candidate);
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        await this.selectDraftScope(candidate, { quiet: true });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this.draftScope = null;
    this.drafts = [];
    this.draftScopeKey = "";
    if (lastError) throw lastError;
  },

  async selectDraftScope(scopeKey, options = {}) {
    const { quiet = false } = options;
    const normalized = normalizeDraftScopeKey(scopeKey) || this.getDefaultDraftScopeKey();
    this.draftsLoading = true;
    try {
      const scopeResponse = await callDraftApi({
        action: "draft_scope_info",
        ...this.getDraftRequestScope(normalized),
      });
      this.draftContextScope = scopeResponse?.context_scope || { project_name: "", agent_profile: "" };
      this.draftScope = scopeResponse?.scope || null;
      this.draftScopeKey = normalizeDraftScopeKey(scopeResponse?.scope?.scope_key) || normalized;
      writeStoredDraftScopeKey(this.draftScopeKey);

      const draftsResponse = await callDraftApi({
        action: "list_drafts",
        ...this.getDraftRequestScope(this.draftScopeKey),
      });
      this.drafts = Array.isArray(draftsResponse?.drafts) ? draftsResponse.drafts : [];
      this.reposition();
      return this.drafts;
    } catch (error) {
      console.error("Failed to load drafts:", error);
      if (!quiet) toastFrontendError(error?.message || "Failed to load Drafts.", "Shortcuts");
      throw error;
    } finally {
      this.draftsLoading = false;
    }
  },

  async refreshDrafts() {
    await this.selectDraftScope(this.draftScopeKey || this.getDefaultDraftScopeKey(), { quiet: true });
  },

  scheduleInputRefresh(options = {}) {
    const { forceReload = false } = options;
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.rafHandle) {
      window.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }

    this.rafHandle = window.requestAnimationFrame(() => {
      this.rafHandle = null;
      this.refreshTimer = window.setTimeout(async () => {
        this.refreshTimer = null;
        if (forceReload) {
          await this.reloadAll();
        }
        this.handleInputLikeEvent();
      }, 0);
    });
  },

  cancelPendingBlurClose() {
    if (this.blurCloseTimer) {
      window.clearTimeout(this.blurCloseTimer);
      this.blurCloseTimer = null;
    }
  },

  isMobileViewport() {
    const vv = window.visualViewport;
    const width = vv?.width || window.innerWidth || 0;
    return width > 0 && width <= 900;
  },

  shouldKeepPopupAliveOnBlur() {
    if (!this.isMobileViewport()) return false;
    const active = document.activeElement;
    if (active === this.inputEl) return true;
    const value = String(this.inputEl?.value || "");
    if (this.activeToken || this.manualPopup || /(?:^|[\s([{"'])\/[A-Za-z0-9_-]*$/.test(value)) return true;
    const vv = window.visualViewport;
    if (vv && this.lastViewportHeight && vv.height < this.lastViewportHeight) return true;
    return false;
  },

  startMobileWatcher() {
    if (!this.isMobileViewport()) return;
    if (this.mobileWatchTimer) return;
    this.mobileWatchTimer = window.setInterval(() => {
      if (!this.inputEl) return;
      const value = String(this.inputEl.value || "");
      if (!value.includes("/") && !this.manualPopup) return;
      this.handleInputLikeEvent();
      this.reposition();
    }, 180);
  },

  stopMobileWatcher() {
    if (this.mobileWatchTimer) {
      window.clearInterval(this.mobileWatchTimer);
      this.mobileWatchTimer = null;
    }
  },

  bindInput() {
    this.inputEl = document.getElementById("chat-input");
    if (!this.inputEl) {
      toastFrontendInfo("Chat input not found for Shortcuts.", "Shortcuts");
      return;
    }

    const onInput = (event) => {
      const inserted = String(event?.data || "");
      if (/\s/.test(inserted) && this.activeToken && !this.manualPopup) {
        this.close();
        return;
      }
      this.scheduleInputRefresh();
    };
    const onBeforeInput = (event) => {
      const inserted = String(event?.data || "");
      const inputType = String(event?.inputType || "");
      if ((/\s/.test(inserted) || inputType === "insertLineBreak") && this.activeToken && !this.manualPopup) {
        this.close();
        return;
      }
      this.scheduleInputRefresh();
    };
    const onCompositionEnd = () => this.scheduleInputRefresh();
    const onClick = () => this.scheduleInputRefresh();
    const onFocus = () => {
      this.isInputFocused = true;
      this.cancelPendingBlurClose();
      this.startMobileWatcher();
      this.scheduleInputRefresh({ forceReload: !this.commands.length });
    };
    const onTouchEnd = () => this.scheduleInputRefresh();
    const onKeyup = () => this.scheduleInputRefresh();
    const onKeydown = (event) => this.handleKeydown(event);
    const onBlur = () => {
      this.isInputFocused = false;
      this.cancelPendingBlurClose();
      if (this.isMobileViewport()) {
        window.setTimeout(() => this.stopMobileWatcher(), 1500);
        this.scheduleInputRefresh();
        return;
      }
      this.blurCloseTimer = window.setTimeout(() => {
        this.blurCloseTimer = null;
        if (this.shouldKeepPopupAliveOnBlur()) {
          this.scheduleInputRefresh();
          return;
        }
        this.close();
      }, 220);
    };
    const onResize = () => {
      const vv = window.visualViewport;
      this.lastViewportHeight = vv?.height || window.innerHeight || this.lastViewportHeight;
      this.reposition();
      this.scheduleInputRefresh();
    };
    const onScroll = () => this.reposition();
    const onViewportChange = () => {
      const vv = window.visualViewport;
      this.lastViewportHeight = vv?.height || window.innerHeight || this.lastViewportHeight;
      this.reposition();
      this.scheduleInputRefresh();
    };
    const onSelectionChange = () => {
      if (document.activeElement === this.inputEl) {
        this.cancelPendingBlurClose();
        this.isInputFocused = true;
        this.scheduleInputRefresh();
      }
    };

    const visualViewport = window.visualViewport || null;
    this.lastViewportHeight = visualViewport?.height || window.innerHeight || 0;

    this.inputEl.addEventListener("input", onInput);
    this.inputEl.addEventListener("beforeinput", onBeforeInput);
    this.inputEl.addEventListener("compositionend", onCompositionEnd);
    this.inputEl.addEventListener("click", onClick);
    this.inputEl.addEventListener("focus", onFocus);
    this.inputEl.addEventListener("touchend", onTouchEnd, { passive: true });
    this.inputEl.addEventListener("keyup", onKeyup);
    this.inputEl.addEventListener("keydown", onKeydown);
    this.inputEl.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    if (visualViewport) {
      visualViewport.addEventListener("resize", onViewportChange);
      visualViewport.addEventListener("scroll", onViewportChange);
    }

    this.cleanupFns.push(() => this.inputEl?.removeEventListener("input", onInput));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("beforeinput", onBeforeInput));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("compositionend", onCompositionEnd));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("click", onClick));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("focus", onFocus));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("touchend", onTouchEnd));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("keyup", onKeyup));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("keydown", onKeydown));
    this.cleanupFns.push(() => this.inputEl?.removeEventListener("blur", onBlur));
    this.cleanupFns.push(() => document.removeEventListener("selectionchange", onSelectionChange));
    this.cleanupFns.push(() => window.removeEventListener("resize", onResize));
    this.cleanupFns.push(() => window.removeEventListener("scroll", onScroll, true));
    if (visualViewport) {
      this.cleanupFns.push(() => visualViewport.removeEventListener("resize", onViewportChange));
      this.cleanupFns.push(() => visualViewport.removeEventListener("scroll", onViewportChange));
    }

    this.handleInputLikeEvent();
  },

  cleanup() {
    for (const fn of this.cleanupFns.splice(0)) {
      try { fn(); } catch {}
    }
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.rafHandle) {
      window.cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.cancelPendingBlurClose();
    this.stopMobileWatcher();
    this.isInputFocused = false;
    this.bound = false;
    this.inputEl = null;
    this.close();
  },

  getCurrentComposerText() {
    const chatInputStore = window.Alpine?.store?.("chatInput");
    return String(this.inputEl?.value || chatInputStore?.message || "");
  },

  setComposerText(text, options = {}) {
    const nextValue = String(text || "");
    const { focus = false } = options;

    if (!this.inputEl) {
      this.inputEl = document.getElementById("chat-input");
    }

    if (this.inputEl) {
      this.inputEl.value = nextValue;
      this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const chatInputStore = window.Alpine?.store?.("chatInput");
    if (chatInputStore) {
      chatInputStore.message = nextValue;
      chatInputStore.adjustTextareaHeight?.();
    }

    if (focus && this.inputEl) {
      this.inputEl.focus();
      const caret = nextValue.length;
      this.inputEl.setSelectionRange?.(caret, caret);
    }
  },

  focusComposer() {
    if (!this.inputEl) {
      this.inputEl = document.getElementById("chat-input");
    }
    this.inputEl?.focus();
  },

  openSharedPopup(view = "shortcuts") {
    if (!this.inputEl) {
      this.inputEl = document.getElementById("chat-input");
    }
    if (!this.inputEl) return;

    this.manualPopup = true;
    this.popupView = view === "drafts" ? "drafts" : "shortcuts";
    this.activeToken = this.detectActiveToken();
    if (this.isShortcutsView) {
      this.filteredCommands = this.filterCommands(this.activeToken?.query || "");
      this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.filteredCommands.length - 1));
    } else {
      this.filteredCommands = [];
      this.selectedIndex = 0;
    }
    this.visible = true;
    this.reposition();
  },

  async openDraftsPopup() {
    await this.initializeDraftScope();
    this.openSharedPopup("drafts");
  },
  openShortcutsPopup() { this.openSharedPopup("shortcuts"); },
  async switchView(view) {
    if (view === "drafts") {
      await this.openDraftsPopup();
      return;
    }
    this.openSharedPopup("shortcuts");
  },
  async toggleDraftsPopup() {
    if (this.visible && this.manualPopup && this.isDraftsView) {
      this.close();
      return;
    }
    await this.openDraftsPopup();
  },

  previewDraft(item) {
    if (!item?.text) {
      toastFrontendInfo("Pick a draft first.", "Shortcuts");
      return;
    }
    window.alert(`${item.label} · ${item.wordCount} words\n\n${item.text}`);
  },

  async removeDraft(item) {
    if (!item?.path) return;
    try {
      await callDraftApi({
        action: "delete_draft",
        ...this.getDraftPayloadFromItem(item),
      });
      await this.refreshDrafts();
      toastFrontendSuccess(`Removed ${item.label}.`, "Shortcuts");
      this.openDraftsPopup();
    } catch (error) {
      console.error("Failed to remove draft:", error);
      toastFrontendError(error?.message || "Failed to remove draft.", "Shortcuts");
    }
  },

  async pinCurrentDraft() {
    const draftText = this.getCurrentComposerText();
    if (!draftText.trim()) {
      toastFrontendInfo("Write something in the composer first.", "Shortcuts");
      return;
    }

    this.draftSaving = true;
    try {
      await this.initializeDraftScope();
      const response = await callDraftApi({
        action: "save_draft",
        ...this.getDraftRequestScope(this.draftScopeKey || this.getDefaultDraftScopeKey()),
        text: draftText,
      });
      await this.refreshDrafts();
      this.setComposerText("", { focus: true });
      toastFrontendSuccess(`Saved draft to ${response?.draft?.scope_label || this.draftScopeLabel}.`, "Shortcuts");
    } catch (error) {
      console.error("Failed to save draft:", error);
      toastFrontendError(error?.message || "Failed to save draft.", "Shortcuts");
    } finally {
      this.draftSaving = false;
    }
  },

  async restoreDraft(item) {
    if (!item?.text) {
      toastFrontendInfo("Pick a draft first.", "Shortcuts");
      return;
    }
    this.setComposerText(item.text, { focus: true });
    try {
      if (item?.path) {
        await callDraftApi({
          action: "delete_draft",
          ...this.getDraftPayloadFromItem(item),
        });
        await this.refreshDrafts();
      }
      this.close();
      toastFrontendSuccess(`Restored ${item.label} to the composer and removed the draft.`, "Shortcuts");
    } catch (error) {
      console.error("Failed to delete restored draft:", error);
      toastFrontendError(error?.message || "Restored draft to composer, but failed to remove stored draft.", "Shortcuts");
    }
  },

  async moveDraftToScope(item, targetScopeKey) {
    if (!item?.text) {
      toastFrontendInfo("Pick a draft first.", "Shortcuts");
      return;
    }
    const normalizedTarget = normalizeDraftScopeKey(targetScopeKey);
    const sourceScope = normalizeDraftScopeKey(item.scope_key || this.draftScopeKey);
    if (!normalizedTarget) {
      toastFrontendInfo("Pick a valid draft scope.", "Shortcuts");
      return;
    }
    if (normalizedTarget === sourceScope) {
      toastFrontendInfo("Draft is already in that scope.", "Shortcuts");
      return;
    }
    try {
      const response = await callDraftApi({
        action: "save_draft",
        ...this.getDraftRequestScope(normalizedTarget),
        text: item.text,
      });
      if (item?.path) {
        await callDraftApi({
          action: "delete_draft",
          ...this.getDraftPayloadFromItem(item),
        });
      }
      await this.refreshDrafts();
      toastFrontendSuccess(`Moved draft to ${response?.draft?.scope_label || normalizedTarget}.`, "Shortcuts");
    } catch (error) {
      console.error("Failed to move draft to scope:", error);
      toastFrontendError(error?.message || "Failed to move draft to that scope.", "Shortcuts");
    }
  },

  createShortcutFromText(text, description = "", options = {}) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      toastFrontendInfo("Nothing to turn into a shortcut yet.", "Shortcuts");
      return;
    }
    const nextProjectName = Object.prototype.hasOwnProperty.call(options, "projectName")
      ? String(options.projectName || "")
      : undefined;
    this.close();
    slashShortcutsManagerStore.openManager({
      openEditor: true,
      prefillInstruction: normalized,
      prefillDescription: description,
      ...(nextProjectName !== undefined ? { projectName: nextProjectName } : {}),
    });
  },

  createShortcutFromDraft(item) {
    if (!item?.text) {
      toastFrontendInfo("Pick a draft first.", "Shortcuts");
      return;
    }
    const projectName = item.scope_key === "global"
      ? ""
      : (item.project_name || this.draftContextScope?.project_name || "");
    if (item.scope_key === "chat") {
      toastFrontendInfo("Chat drafts open in the current project shortcut scope because chat-only shortcuts do not exist yet.", "Shortcuts");
    }
    this.createShortcutFromText(
      item.text,
      `Create shortcut from ${String(item.scope_label || "draft").toLowerCase()} draft.`,
      { projectName },
    );
  },

  handleInputLikeEvent() {
    if (!this.inputEl) { this.close(); return; }

    if (this.manualPopup) {
      this.activeToken = this.detectActiveToken();
      if (this.isShortcutsView) {
        this.filteredCommands = this.filterCommands(this.activeToken?.query || "");
        this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.filteredCommands.length - 1));
      } else {
        this.filteredCommands = [];
        this.selectedIndex = 0;
      }
      this.visible = true;
      this.reposition();
      return;
    }

    if (!this.config?.enabled) { this.close(); return; }
    const token = this.detectActiveToken();
    if (!token) { this.close(); return; }
    this.popupView = "shortcuts";
    this.activeToken = token;
    this.filteredCommands = this.filterCommands(token.query);
    if (!this.filteredCommands.length) {
      this.visible = true;
      this.selectedIndex = 0;
      this.reposition();
      return;
    }
    this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.filteredCommands.length - 1));
    this.visible = true;
    this.reposition();
  },

  detectActiveToken() {
    const el = this.inputEl;
    if (!el) return null;
    const value = String(el.value || "");
    const hasNumericCaret = typeof el.selectionStart === "number";
    const caret = hasNumericCaret ? el.selectionStart : value.length;
    const left = value.slice(0, caret);
    const slashIndex = left.lastIndexOf("/");
    if (slashIndex >= 0) {
      const beforeSlash = slashIndex === 0 ? "" : left[slashIndex - 1];
      if (!beforeSlash || /\s|[([{>"']/.test(beforeSlash)) {
        const afterSlash = left.slice(slashIndex + 1);
        const match = afterSlash.match(/^([A-Za-z0-9_-]*)$/);
        if (match) return { start: slashIndex, end: caret, query: match[1] };
        const trailingMatch = afterSlash.match(/(?:^|[\s([{"'])\/([A-Za-z0-9_-]*)$/);
        if (trailingMatch) {
          const query = trailingMatch[1] || "";
          return { start: caret - query.length - 1, end: caret, query };
        }
      }
    }

    if (this.isMobileViewport()) {
      const trailingMobileMatch = left.match(/(?:^|[\s([{"'])\/([A-Za-z0-9_-]*)$/);
      if (trailingMobileMatch) {
        const query = String(trailingMobileMatch[1] || "");
        return { start: caret - query.length - 1, end: caret, query };
      }
    }

    return null;
  },

  filterCommands(query) {
    const q = String(query || "").trim().toLowerCase();
    const allowDescription = !!this.config?.match_descriptions;
    const scored = this.commands
      .map((item, index) => {
        const command = item.command.toLowerCase();
        const label = (item.display_label || item.command || "").toLowerCase();
        const description = (item.description || "").toLowerCase();
        let score = 0;
        if (!q) score = 1000 - index;
        else if (command === q) score = 5000 - index;
        else if (command.startsWith(q)) score = 4000 - index;
        else if (label.startsWith(q)) score = 3500 - index;
        else if (command.includes(q)) score = 3000 - index;
        else if (label.includes(q)) score = 1500 - index;
        else if (allowDescription && description.includes(q)) score = 1000 - index;
        return score > 0 ? { item, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
    const limit = clamp(parseInt(this.config?.max_visible_items || 7, 10) || 7, 1, 20);
    return scored.slice(0, limit);
  },

  handleKeydown(event) {
    if (!this.visible) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (!this.isShortcutsView) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (this.filteredCommands.length) this.selectedIndex = (this.selectedIndex + 1) % this.filteredCommands.length;
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (this.filteredCommands.length) this.selectedIndex = (this.selectedIndex - 1 + this.filteredCommands.length) % this.filteredCommands.length;
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) || event.key === "Tab") {
      event.preventDefault();
      if (this.filteredCommands.length) {
        this.applyByIndex(this.selectedIndex);
      } else {
        this.close();
      }
      return;
    }
    if (event.key === " " && !this.manualPopup) {
      this.activeToken = null;
      this.close();
      return;
    }
    if (event.key === "Backspace" && !this.manualPopup && !this.filteredCommands.length && !this.activeToken?.query) {
      this.close();
    }
  },

  setSelectedIndex(index) { this.selectedIndex = index; },

  openCreateShortcut() {
    slashShortcutsManagerStore.openManager({
      prefillName: this.activeToken?.query || "",
      openEditor: true,
    });
    this.close();
  },

  applyByIndex(index, options = {}) {
    const item = this.filteredCommands[index];
    if (!item) return;
    if (!this.inputEl) {
      this.inputEl = document.getElementById("chat-input");
    }
    if (!this.inputEl) return;

    const value = String(this.inputEl.value || "");
    const token = this.activeToken || this.detectActiveToken();
    const supportsArguments = !!item.argument_hint || /[$]ARGUMENTS|[$][0-9]/.test(String(item.instruction || ""));
    const insertedCommand = supportsArguments ? `/${item.command}${ACCEPT_MARKER}()` : `/${item.command}${ACCEPT_MARKER}`;
    const defaultTrailingText = supportsArguments ? "" : " ";
    const trailingText = Object.prototype.hasOwnProperty.call(options, "trailingText")
      ? String(options.trailingText || "")
      : defaultTrailingText;

    let before = "";
    let after = "";
    let nextCaret = 0;

    if (token) {
      before = value.slice(0, token.start);
      after = value.slice(token.end);
      const safeTrailingText = trailingText && (after.startsWith(" ") || after.startsWith("\n")) ? "" : trailingText;
      const nextValue = `${before}${insertedCommand}${safeTrailingText}${after}`;
      nextCaret = supportsArguments && !safeTrailingText
        ? (before + `/${item.command}${ACCEPT_MARKER}(`).length
        : (before + insertedCommand + safeTrailingText).length;
      this.setComposerText(nextValue);
      this.focusComposer();
      this.inputEl.setSelectionRange?.(nextCaret, nextCaret);
    } else {
      const caret = typeof this.inputEl.selectionStart === "number" ? this.inputEl.selectionStart : value.length;
      before = value.slice(0, caret);
      after = value.slice(caret);
      const needsLeadingSpace = before && !/[\s([{"']$/.test(before);
      const safeLeadingText = needsLeadingSpace ? " " : "";
      const safeTrailingText = trailingText && (after.startsWith(" ") || after.startsWith("\n")) ? "" : trailingText;
      const nextValue = `${before}${safeLeadingText}${insertedCommand}${safeTrailingText}${after}`;
      nextCaret = supportsArguments && !safeTrailingText
        ? (before + safeLeadingText + `/${item.command}${ACCEPT_MARKER}(`).length
        : (before + safeLeadingText + insertedCommand + safeTrailingText).length;
      this.setComposerText(nextValue);
      this.focusComposer();
      this.inputEl.setSelectionRange?.(nextCaret, nextCaret);
    }

    if (this.manualPopup || this.config?.keep_popup_open_after_insert) this.openShortcutsPopup();
    else this.close();
  },

  reposition() {
    if (!this.visible || !this.inputEl) {
      this.popupStyle = "left:-9999px;top:-9999px;";
      return;
    }
    const rect = this.inputEl.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewportWidth = vv?.width || window.innerWidth;
    const viewportHeight = vv?.height || window.innerHeight;
    const viewportLeft = vv?.offsetLeft || 0;
    const viewportTop = vv?.offsetTop || 0;

    const baseWidth = clamp(parseInt(this.config?.popup_width || 320, 10) || 320, 240, Math.max(240, viewportWidth - 16));
    const baseConfiguredHeight = clamp(parseInt(this.config?.popup_height || (this.compactMode ? 200 : 320), 10) || (this.compactMode ? 200 : 320), 160, 560);
    const draftsConfiguredWidth = clamp(parseInt(this.config?.drafts_popup_width || 520, 10) || 520, 320, Math.max(320, viewportWidth - 16));
    const draftsConfiguredHeight = clamp(parseInt(this.config?.drafts_popup_height || 420, 10) || 420, 180, 760);
    const width = this.isDraftsView
      ? Math.min(draftsConfiguredWidth, Math.max(260, viewportWidth - 16))
      : baseWidth;
    const estimatedHeight = this.isDraftsView
      ? Math.min(draftsConfiguredHeight, Math.max(220, viewportHeight - 16))
      : Math.min(baseConfiguredHeight, Math.max(160, viewportHeight - 16));

    const yOffset = clamp(parseInt(this.config?.popup_offset_y || 14, 10) || 14, 0, 120);
    const xOffset = clamp(parseInt(this.config?.popup_offset_x || 0, 10) || 0, -120, 120);

    if (this.isMobileViewport()) {
      const safeLeft = viewportLeft + 8;
      const mobileWidth = Math.max(240, viewportWidth - 16);
      const mobileMaxHeight = this.isDraftsView
        ? Math.min(Math.max(260, estimatedHeight), Math.max(260, viewportHeight - 16))
        : Math.min(Math.max(200, estimatedHeight), Math.max(200, viewportHeight - 16));
      const mobileTop = viewportTop + 8;
      this.popupStyle = `left:${safeLeft}px;top:${mobileTop}px;bottom:auto;width:${mobileWidth}px;height:${mobileMaxHeight}px;`;
      return;
    }

    const preferredTop = rect.top - estimatedHeight - yOffset;
    const fallbackBelowTop = rect.bottom + 4;
    const top = preferredTop >= viewportTop + 8
      ? preferredTop
      : Math.min(viewportTop + viewportHeight - estimatedHeight - 8, fallbackBelowTop);
    const safeTop = Math.max(viewportTop + 8, top);
    const preferredLeft = rect.left + xOffset;
    const left = Math.min(
      Math.max(preferredLeft, viewportLeft + 8),
      Math.max(viewportLeft + 8, viewportLeft + viewportWidth - width - 8),
    );
    this.popupStyle = `left:${left}px;top:${safeTop}px;bottom:auto;width:${width}px;height:${estimatedHeight}px;`;
  },

  close() {
    this.visible = false;
    this.filteredCommands = [];
    this.selectedIndex = 0;
    this.activeToken = null;
    this.popupStyle = "left:-9999px;top:-9999px;";
    this.popupView = "shortcuts";
    this.manualPopup = false;
  },
});
