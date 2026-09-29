// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js - the Claude (claude.ai, Anthropic) provider.
// Exports the same ZSProvider interface as providers/deepseek.js and chatgpt.js;
// the core (core/main.js) is provider-agnostic.
//
// Claude.ai DOM notes:
//  - React / Next.js app.
//  - Message turns: User messages carry [data-testid="user-message"] or
//    .font-user-message; assistant messages carry [data-testid="assistant-message"]
//    or .font-claude-message.
//  - Thinking / reasoning (Claude 3.7 Sonnet extended thinking) renders in
//    [data-testid="thinking-content"], [class*="thinking"], or details elements.
//    Excluded from reply text extraction to prevent drafts inside thinking from
//    executing prematurely.
//  - Composer: ProseMirror contenteditable container (div[contenteditable="true"].ProseMirror).
//    Text is injected via selectAll + chunked execCommand("insertText") with
//    execCommand("insertLineBreak") to ensure proper newlines without creating file attachments.
//  - Send button: button[aria-label*="Send" i], button[data-testid="send-button"].
//  - Stop button: button[aria-label*="Stop" i], button[data-testid="stop-button"].
//    Replaces the send button while generating.
//  - Fenced code blocks: <pre><code>...</code></pre> with preserved whitespace and newlines.
//  - Image input: supports vision natively (supportsVision: true).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: '[data-testid="user-message"], .font-user-message, [class*="font-user-message"], [data-message-author-role="user"]',
    assistantItem: '[data-testid="assistant-message"], .font-claude-message, [class*="font-claude-message"], [data-message-author-role="assistant"]',
    thinking: '[data-testid="thinking-content"], [class*="thinking"], details:has([class*="thought"])',
    editor: 'div[contenteditable="true"].ProseMirror, [data-testid="chat-input"], div[contenteditable="true"]',
    composer: 'fieldset, [data-testid="chat-input-container"], form, div:has(> div[contenteditable="true"])',
    sendBtn: 'button[aria-label*="Send" i], button[aria-label*="Envoyer" i], button[data-testid="send-button"]',
    stopBtn: 'button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], button[aria-label*="Interrompre" i], button[data-testid="stop-button"], button[aria-label="Stop Response"], button[aria-label="Stop response"]',
    codeWrap: "pre, .code-block, [class*='code-block']",
    errorSurfaces: '[role="alert"], [class*="toast"], [class*="error"], [data-testid*="error"], [class*="banner"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "message.{0,20}limit.{0,10}reached",
        "free.{0,10}plan.{0,10}limit",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "rate.{0,10}limit",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)|message is too long/i,
    busy: /something went wrong|une erreur s.est produite|please try again|server is busy|service unavailable|rate limit|too many requests/i,
    continueBtn: /^(continue|continuer|continue generating)$/i,
  };

  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  function isUserItem(item) {
    if (!item) return false;
    if (item.matches && item.matches(S.userItem)) return true;
    if (item.querySelector && item.querySelector(S.userItem)) return true;
    return false;
  }

  function isAssistantItem(item) {
    if (!item) return false;
    if (isUserItem(item)) return false;
    if (item.matches && item.matches(S.assistantItem)) return true;
    if (item.querySelector && item.querySelector(S.assistantItem)) return true;
    return true;
  }

  function allItems() {
    const raw = [
      ...document.querySelectorAll(
        '[data-testid="user-message"], [data-testid="assistant-message"], ' +
        '.font-user-message, .font-claude-message, ' +
        '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ),
    ].filter((el) => !el.closest("#zs-root"));

    // Deduplicate nested elements so each turn is represented once
    const items = [];
    for (const el of raw) {
      if (items.some((it) => it.contains(el))) continue;
      const idx = items.findIndex((it) => el.contains(it));
      if (idx !== -1) {
        items[idx] = el;
      } else {
        items.push(el);
      }
    }
    return items;
  }

  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  function itemKey(item) {
    if (!item) return null;
    const id = item.getAttribute("data-message-id") || (item.dataset && item.dataset.messageId);
    return id || null;
  }

  function lastAssistantId() {
    return itemKey(lastAssistant());
  }

  // ── Text extraction ───────────────────────────────────────────────────────
  const BLOCK_TAGS = /^(?:P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|TABLE|TR|SECTION|ARTICLE|HR)$/i;

  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = (S.thinking ? S.thinking + ", " : "") + ".zs-chip" + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) {
        t += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      try {
        if (n.matches && n.matches(skip)) return;
      } catch {}
      if (n.tagName === "BR") {
        t += "\n";
        return;
      }
      const isBlock = BLOCK_TAGS.test(n.tagName);
      if (isBlock && t.length > 0 && !t.endsWith("\n")) t += "\n";
      for (const c of n.childNodes) walk(c);
      if (isBlock && t.length > 0 && !t.endsWith("\n")) t += "\n";
    };
    walk(root);
    return t;
  }

  function itemText(item) {
    return textWithout(item, null).trim();
  }

  function classifyText(item, excludeSel) {
    return textWithout(item, excludeSel).trim();
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const thEl = item.querySelector(S.thinking);
    const thinking = thEl ? (thEl.textContent || "").trim() : "";
    const reply = textWithout(item, S.thinking).trim();
    return {
      present: true,
      reply,
      thinking,
      item,
    };
  }

  // ── Stream tracking & Generation detection ────────────────────────────────
  function streamText(item) {
    if (!item) return "";
    return textWithout(item, null);
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item;
      _streamMax = len;
      _streamAt = now;
      return;
    }
    if (len > _streamMax) {
      _streamMax = len;
      _streamAt = now;
    }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function isStopBtn(btn) {
    if (!btn) return false;
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (/stop|arr[êe]ter|interrompre/i.test(aria)) return true;
    if (btn.getAttribute("data-testid") === "stop-button") return true;
    if (btn.querySelector && btn.querySelector("rect")) return true;
    const path = btn.querySelector && btn.querySelector("path");
    if (path) {
      const d = path.getAttribute("d") || "";
      if (/rect/i.test(d) || /M[0-9.]+\s+[0-9.]+h[0-9.]+\s*v[0-9.]+/i.test(d)) return true;
    }
    return false;
  }

  function isHardGenerating() {
    const stop = document.querySelector(S.stopBtn);
    if (stop && isStopBtn(stop)) return true;
    const send = document.querySelector(S.sendBtn);
    if (send && isStopBtn(send)) return true;
    const streaming = document.querySelector('[data-is-streaming="true"]');
    if (streaming) return true;
    return false;
  }

  function isGenerating() {
    if (isHardGenerating()) return true;
    sampleStream();
    return grewWithin(timings.GEN_IDLE_MS);
  }

  function isBusyNow() {
    if (isHardGenerating()) return true;
    sampleStream();
    return grewWithin(timings.GEN_IDLE_MS);
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const thEl = it.querySelector(S.thinking);
      const th = thEl ? (thEl.textContent || "").trim().length : 0;
      const rp = textWithout(it, S.thinking).trim().length;
      return { th, rp };
    } catch {
      return {};
    }
  }

  function turnHalted(item) {
    if (!item) return false;
    if (item.getAttribute("data-is-stopped") === "true") return true;
    return false;
  }

  // ── Composer / State ──────────────────────────────────────────────────────
  const chatIsEmpty = () => allItems().length === 0;

  function getEditor() {
    const editors = [...document.querySelectorAll(S.editor)].filter(
      (e) => !e.closest("#zs-root")
    );
    return editors.find((e) => e.offsetParent !== null) || editors[0] || null;
  }

  function editorText() {
    const ed = getEditor();
    if (!ed) return "";
    return (ed.textContent || "").trim();
  }

  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    ed.setAttribute("contenteditable", on ? "false" : "true");
    if (on) {
      ed.setAttribute("data-zs-locked", "1");
    } else {
      ed.removeAttribute("data-zs-locked");
    }
  }

  function composerFrame() {
    const ed = getEditor();
    if (!ed) return null;
    const send = document.querySelector(S.sendBtn) || document.querySelector(S.stopBtn);
    let n = ed.parentElement;
    for (let i = 0; i < 10 && n && n !== document.body; i++) {
      if (n.matches && (n.matches("fieldset") || n.matches("form") || n.matches('[data-testid*="container"]'))) return n;
      if (send && n.contains(send)) return n;
      n = n.parentElement;
    }
    return ed.closest("fieldset") || ed.parentElement || null;
  }

  function barMount() {
    const ed = getEditor();
    if (!ed) return null;
    const frame = composerFrame();
    if (!frame) return null;
    let before = frame.firstElementChild;
    if (before && before.id === "zs-bar") before = before.nextElementSibling;
    return { parent: frame, before, inside: true };
  }

  function enforceComposer(reason) {
    return { ready: !!getEditor() };
  }

  async function ensureComposerReady(reason) {
    for (let i = 0; i < 10; i++) {
      if (getEditor()) return { ready: true };
      await sleep(150);
    }
    return { ready: !!getEditor() };
  }

  const isFreshChat = () => chatIsEmpty() && !!getEditor() && !/^\/chat\/[^/]+/.test(location.pathname);
  const conversationKey = () => (/^\/chat\/[^/]+/.test(location.pathname) ? location.pathname : "");

  // ── Typing and Sending ────────────────────────────────────────────────────
  function selectAll(ed) {
    ed.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function typeEditorText(ed, text) {
    selectAll(ed);
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
      if (i < lines.length - 1) {
        document.execCommand("insertLineBreak");
      }
      if (i && i % 25 === 0) await sleep(0);
    }
  }

  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }

  function sendButton() {
    const btn = document.querySelector(S.sendBtn) || document.querySelector(S.stopBtn);
    return btn && !isStopBtn(btn) ? btn : null;
  }

  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = sendButton();
    if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    return false;
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  async function typeAndSend(text, images) {
    const ed = getEditor();
    if (!ed) throw new Error("Claude input box not found");
    const wasLocked = _locked;
    if (wasLocked) ed.setAttribute("contenteditable", "true");
    try {
      await typeEditorText(ed, text);
      ed.dispatchEvent(new Event("input", { bubbles: true }));

      if (images && images.length) {
        try { await attachImages(images); } catch {}
        const t0 = Date.now();
        while (Date.now() - t0 < 25000) {
          const btn = sendButton();
          if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
            try { btn.click(); } catch {}
          }
          if (await waitFor(() => editorText().trim() === "" || isHardGenerating(), 1200)) return;
        }
        return;
      }

      await waitFor(() => {
        const btn = sendButton();
        return btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true" && !isStopBtn(btn);
      }, 1200);

      if (!clickSendButton() && !isBusyNow()) {
        pressEnter(ed);
      }
    } finally {
      if (wasLocked) ed.setAttribute("contenteditable", "false");
    }
  }

  function stopGeneration() {
    const btn = document.querySelector(S.stopBtn) || document.querySelector('button[aria-label*="Stop" i]');
    if (btn) {
      try { btn.click(); } catch {}
    }
  }

  function findContinueBtn() {
    for (const b of document.querySelectorAll("button")) {
      if (b.offsetParent === null) continue;
      if (RE.continueBtn.test((b.innerText || b.getAttribute("aria-label") || "").trim())) return b;
    }
    return null;
  }

  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }

  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.assistantItem) || el.closest(S.userItem)) continue;
        const t = (el.innerText || el.textContent || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }

  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  // ── Image Attachment ──────────────────────────────────────────────────────
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }

  async function attachImages(images) {
    const ed = getEditor();
    if (!ed || !images || !images.length) return false;
    const dt = new DataTransfer();
    images.forEach((img, i) => {
      try { dt.items.add(fileFromImage(img, i)); } catch {}
    });
    if (!dt.items.length) return false;
    ed.focus();
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {}
    } else {
      ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    return await waitFor(() => {
      const frame = composerFrame();
      return !!(frame && frame.querySelector("img, [class*='thumbnail'], [class*='preview'], [class*='attachment']"));
    }, 15000);
  }

  function clearAttachments() {
    try {
      const frame = composerFrame();
      if (!frame) return;
      frame.querySelectorAll("[aria-label*='Remove'], [aria-label*='delete'], [class*='remove'], [class*='delete']")
        .forEach((b) => { try { b.click(); } catch {} });
    } catch {}
  }

  // ── User-send interception ────────────────────────────────────────────────
  function installSendHooks(handlers) {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        const ed = getEditor();
        if (!ed || !ed.contains(e.target)) return;
        if (editorText().trim() === "") return;
        if (handlers.isBlocked()) return;

        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );

    document.addEventListener(
      "click",
      (e) => {
        if (!getEditor()) return;
        const t = e.target;
        const cont = t && t.closest && t.closest("button");
        if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
          handlers.onNativeContinue();
          return;
        }
        const stop = t && t.closest && t.closest(S.stopBtn);
        if (stop) {
          handlers.onNativeStop();
          return;
        }
        const btn = t && t.closest && t.closest(S.sendBtn);
        if (!btn || isStopBtn(btn)) return;
        if (handlers.isBlocked()) return;
        if (!handlers.isStarted()) {
          if (!chatIsEmpty()) return;
          handlers.onBlockedAttempt();
          return;
        }
        handlers.onUserMessage(assistantCount());
      },
      true
    );
  }

  // ── Tool block hiding ─────────────────────────────────────────────────────
  function findToolBlockSpot(item) {
    if (!item) return null;
    let hidAny = null;
    const hide = (el) => {
      el.classList.add("zs-tool-hide");
      item.classList.add("zs-cmd-mask");
      hidAny = hidAny || { parent: el.parentElement, ref: el };
    };

    // 1. Fenced code blocks carrying a command
    const preList = item.querySelectorAll("pre, .code-block, [class*='code-block']");
    for (const pre of preList) {
      if (pre.closest && pre.closest(".zs-chip")) continue;
      const txt = pre.textContent || "";
      if (ZSParse.hasCommandShape(txt) || ZSParse.LUA_START_RE.test(txt)) {
        hide(pre);
      }
    }

    // 2. Bare paragraphs or leaf elements containing the command (never hide a container of pre!)
    const blocks = item.querySelectorAll("p, div, li");
    for (const el of blocks) {
      if (el.classList.contains("zs-chip") || el.classList.contains("zs-tool-hide")) continue;
      if (el.querySelector("pre, .code-block, [class*='code-block']")) continue;
      if (el.querySelector("p, div, ul, ol")) continue;
      const txt = (el.textContent || "").trim();
      if (txt.length < 600 && (ZSParse.hasCommandShape(txt) || ZSParse.LUA_START_RE.test(txt))) {
        hide(el);
      }
    }

    return hidAny;
  }

  function chipAnchor(item) {
    if (!item) return item;
    if (item.matches && item.matches(".font-claude-message")) return item;
    const inner = item.querySelector && item.querySelector(".font-claude-message");
    return inner || item;
  }

  const PROMPT_EXTRA = `- When working with Roblox Studio, inspect existing scripts and hierarchy before proposing major changes, and output one tool command at a time.`;

  return {
    id: "claude",
    displayName: "Claude",
    supportsVision: true,
    friendlyPrompt: true,
    chipAtItemLevel: true,
    chipAppend: true,
    chipAnchor,
    promptExtra: PROMPT_EXTRA,
    timings,
    thinkingSel: S.thinking,
    init({ diag: d } = {}) {
      if (d) diag = d;
    },
    // turns
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    // composer / state
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    // actions
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
