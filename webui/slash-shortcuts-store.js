import { createStore } from "/js/AlpineStore.js";
import { toastFrontendError, toastFrontendInfo } from "/components/notifications/notification-store.js";
import { ACCEPT_MARKER, DEFAULT_CONFIG, buildExpandedMessage, detectCommandsInMessage, loadEffectiveShortcuts, loadPluginConfig } from "/plugins/slash_shortcuts/webui/slash-shortcuts-core.js?v=2.3.1";
import { store as slashShortcutsManagerStore } from "/plugins/slash_shortcuts/webui/slash-shortcuts-manager-store.js?v=2.3.1";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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
  originalGlobalSendMessage: null,
  patchedGlobalSendMessage: null,
  originalChatInputSendMessage: null,
  patchedChatInputSendMessage: null,
  patchRetryTimer: null,
  patchRetryDeadline: 0,
  refreshTimer: null,
  rafHandle: null,
  blurCloseTimer: null,
  mobileWatchTimer: null,
  isInputFocused: false,
  lastViewportHeight: 0,
  cleanupFns: [],

  init() {},
  get showDescriptions() { return !!this.config?.show_descriptions; },
  get compactMode() { return !!this.config?.compact_mode; },
  get currentQueryDisplay() {
    const q = this.activeToken?.query || "";
    return q ? `/${q}` : "/";
  },

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
    if (this.activeToken || /(?:^|[\s([{"'])\/[A-Za-z0-9_-]*$/.test(value)) return true;
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
      if (!value.includes("/")) return;
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
      if (/\s/.test(inserted) && this.activeToken) {
        this.close();
        return;
      }
      this.scheduleInputRefresh();
    };
    const onBeforeInput = (event) => {
      const inserted = String(event?.data || "");
      const inputType = String(event?.inputType || "");
      if ((/\s/.test(inserted) || inputType === "insertLineBreak") && this.activeToken) {
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

    this.startSendHookPatchLoop();
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
    this.stopSendHookPatchLoop();
    this.restorePatchedSendHooks();
    this.bound = false;
    this.inputEl = null;
    this.close();
  },

  startSendHookPatchLoop() {
    this.tryPatchSendHooks();
    this.stopSendHookPatchLoop();
    this.patchRetryDeadline = Date.now() + 15000;
    this.patchRetryTimer = window.setInterval(() => {
      this.tryPatchSendHooks();
      if (this.areSendHooksPatched() || Date.now() > this.patchRetryDeadline) this.stopSendHookPatchLoop();
    }, 250);
  },

  stopSendHookPatchLoop() {
    if (this.patchRetryTimer) {
      window.clearInterval(this.patchRetryTimer);
      this.patchRetryTimer = null;
    }
  },

  areSendHooksPatched() {
    return !!(this.patchedGlobalSendMessage || this.patchedChatInputSendMessage);
  },

  restorePatchedSendHooks() {
    if (this.originalGlobalSendMessage && globalThis.sendMessage === this.patchedGlobalSendMessage) globalThis.sendMessage = this.originalGlobalSendMessage;
    const chatInputStore = window.Alpine?.store?.("chatInput");
    if (this.originalChatInputSendMessage && chatInputStore?.sendMessage === this.patchedChatInputSendMessage) chatInputStore.sendMessage = this.originalChatInputSendMessage;
    this.originalGlobalSendMessage = null;
    this.patchedGlobalSendMessage = null;
    this.originalChatInputSendMessage = null;
    this.patchedChatInputSendMessage = null;
  },

  tryPatchSendHooks() {
    const chatInputStore = window.Alpine?.store?.("chatInput");
    if (!this.originalGlobalSendMessage && typeof globalThis.sendMessage === "function") {
      this.originalGlobalSendMessage = globalThis.sendMessage;
      this.patchedGlobalSendMessage = async (...args) => {
        await this.expandCurrentInputBeforeSend();
        return await this.originalGlobalSendMessage(...args);
      };
      globalThis.sendMessage = this.patchedGlobalSendMessage;
    }
    if (!this.originalChatInputSendMessage && typeof chatInputStore?.sendMessage === "function") {
      this.originalChatInputSendMessage = chatInputStore.sendMessage.bind(chatInputStore);
      this.patchedChatInputSendMessage = async (...args) => {
        await this.expandCurrentInputBeforeSend();
        return await this.originalChatInputSendMessage(...args);
      };
      chatInputStore.sendMessage = this.patchedChatInputSendMessage;
    }
  },

  async expandCurrentInputBeforeSend() {
    try {
      await this.reloadAll();
      const chatInputStore = window.Alpine?.store?.("chatInput");
      const currentText = String(this.inputEl?.value || chatInputStore?.message || "");
      if (!this.config?.enabled || !currentText.trim()) return;
      const matched = detectCommandsInMessage(currentText, this.commands);
      if (!matched.length) return;
      const expanded = buildExpandedMessage(currentText, matched);
      if (this.inputEl) {
        this.inputEl.value = expanded;
        this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (chatInputStore) {
        chatInputStore.message = expanded;
        chatInputStore.adjustTextareaHeight?.();
      }
    } catch (error) {
      console.error("[slash_shortcuts] pre-send expansion failed", error);
    }
  },

  handleInputLikeEvent() {
    if (!this.config?.enabled || !this.inputEl) { this.close(); return; }
    const token = this.detectActiveToken();
    if (!token) { this.close(); return; }
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
    if (event.key === " ") {
      this.activeToken = null;
      this.close();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "Backspace" && !this.filteredCommands.length && !this.activeToken?.query) {
      this.close();
    }
  },

  setSelectedIndex(index) { this.selectedIndex = index; },

  openCreateShortcut() {
    slashShortcutsManagerStore.openManager({ projectName: "", agentProfile: "", prefillName: this.activeToken?.query || "", openEditor: true });
    this.close();
  },

  applyByIndex(index, options = {}) {
    const item = this.filteredCommands[index];
    if (!item || !this.inputEl) return;
    const value = this.inputEl.value || "";
    const token = this.activeToken || this.detectActiveToken();
    if (!token) return;

    const supportsArguments = !!item.argument_hint || /[$]ARGUMENTS|[$][0-9]/.test(String(item.instruction || ""));
    const insertedCommand = supportsArguments ? `/${item.command}${ACCEPT_MARKER}()` : `/${item.command}${ACCEPT_MARKER}`;
    const defaultTrailingText = supportsArguments ? "" : " ";
    const trailingText = Object.prototype.hasOwnProperty.call(options, "trailingText")
      ? String(options.trailingText || "")
      : defaultTrailingText;
    const before = value.slice(0, token.start);
    const after = value.slice(token.end);
    const safeTrailingText = trailingText && (after.startsWith(" ") || after.startsWith("
")) ? "" : trailingText;
    const nextValue = `${before}${insertedCommand}${safeTrailingText}${after}`;
    const nextCaret = supportsArguments && !safeTrailingText
      ? (before + `/${item.command}${ACCEPT_MARKER}(`).length
      : (before + insertedCommand + safeTrailingText).length;

    this.inputEl.value = nextValue;
    if (window.Alpine?.store?.("chatInput")) {
      window.Alpine.store("chatInput").message = nextValue;
      window.Alpine.store("chatInput").adjustTextareaHeight?.();
    }
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.inputEl.focus();
    this.inputEl.setSelectionRange(nextCaret, nextCaret);
    if (this.config?.keep_popup_open_after_insert) this.handleInputLikeEvent();
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
    const width = clamp(parseInt(this.config?.popup_width || 320, 10) || 320, 220, Math.max(220, viewportWidth - 16));
    const configuredHeight = clamp(parseInt(this.config?.popup_height || (this.compactMode ? 156 : 220), 10) || (this.compactMode ? 156 : 220), 100, 520);
    const estimatedHeight = Math.min(configuredHeight, Math.max(100, viewportHeight - 16));
    const yOffset = clamp(parseInt(this.config?.popup_offset_y || 14, 10) || 14, 0, 120);
    const xOffset = clamp(parseInt(this.config?.popup_offset_x || 0, 10) || 0, -120, 120);

    if (this.isMobileViewport()) {
      const safeLeft = viewportLeft + 8;
      const mobileWidth = Math.max(220, viewportWidth - 16);
      const mobileMaxHeight = Math.min(Math.max(160, estimatedHeight), Math.max(160, viewportHeight - 16));
      const mobileTop = viewportTop + 8;
      this.popupStyle = `left:${safeLeft}px;top:${mobileTop}px;bottom:auto;width:${mobileWidth}px;height:${mobileMaxHeight}px;`;
      return;
    }

    const preferredTop = rect.top - estimatedHeight - yOffset;
    const fallbackBelowTop = rect.bottom + 4;
    const top = preferredTop >= viewportTop + 8 ? preferredTop : Math.min(viewportTop + viewportHeight - estimatedHeight - 8, fallbackBelowTop);
    const safeTop = Math.max(viewportTop + 8, top);
    const left = Math.min(Math.max(rect.left + xOffset, viewportLeft + 8), Math.max(viewportLeft + 8, viewportLeft + viewportWidth - width - 8));
    this.popupStyle = `left:${left}px;top:${safeTop}px;bottom:auto;width:${width}px;height:${estimatedHeight}px;`;
  },

  close() {
    this.visible = false;
    this.filteredCommands = [];
    this.selectedIndex = 0;
    this.activeToken = null;
    this.popupStyle = "left:-9999px;top:-9999px;";
  },
});
