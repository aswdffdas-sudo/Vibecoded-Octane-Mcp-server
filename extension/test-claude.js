// Quick Node smoke test for providers/claude.js (run: node test-claude.js).
const fs = require("fs");

function txt(v) {
  return { nodeType: 3, nodeValue: v, childNodes: [] };
}
function el(tag, opts, children) {
  const o = opts || {};
  const classes = (o.class || "").split(/\s+/).filter(Boolean);
  const attrs = o.attrs || {};
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: (children || []).map((c) => (typeof c === "string" ? txt(c) : c)),
    classList: {
      contains: (c) => classes.includes(c),
      add: (c) => { if (!classes.includes(c)) classes.push(c); },
      remove: (c) => { const idx = classes.indexOf(c); if (idx !== -1) classes.splice(idx, 1); },
    },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = String(v); },
    removeAttribute: (n) => { delete attrs[n]; },
    matches: (sel) => {
      const parts = sel.split(",").map((s) => s.trim());
      return parts.some((p) => {
        if (p.startsWith(".")) return classes.includes(p.slice(1));
        if (p.startsWith("[")) {
          const m = p.match(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)"([^"]*)")?\]/);
          if (!m) return false;
          const attr = m[1], op = m[2], val = m[3];
          if (!(attr in attrs)) return false;
          if (!op) return true;
          if (op === "=") return attrs[attr] === val;
          if (op === "*=") return attrs[attr].includes(val);
          return false;
        }
        return node.tagName.toLowerCase() === p.toLowerCase();
      });
    },
    contains: (other) => {
      if (node === other) return true;
      for (const c of node.childNodes) {
        if (c === other || (c.contains && c.contains(other))) return true;
      }
      return false;
    },
    closest: (sel) => {
      let cur = node;
      while (cur) {
        if (cur.matches && cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
  };
  node.childNodes.forEach((c) => { c.parentElement = node; });
  node.children = node.childNodes.filter((c) => c.nodeType === 1);
  node.querySelectorAll = (sel) => {
    const res = [];
    const walk = (n) => {
      if (n.nodeType === 1 && n.matches && n.matches(sel)) res.push(n);
      for (const c of n.childNodes || []) walk(c);
    };
    for (const c of node.childNodes) walk(c);
    return res;
  };
  node.querySelector = (sel) => {
    const list = node.querySelectorAll(sel);
    return list.length ? list[0] : null;
  };
  Object.defineProperty(node, "textContent", {
    get() {
      let s = "";
      const walk = (n) => {
        if (n.nodeType === 3) s += n.nodeValue;
        for (const c of n.childNodes || []) walk(c);
      };
      walk(node);
      return s;
    },
  });
  return node;
}

global.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: { classList: { contains: () => false, add: () => {} } },
  body: null,
};
global.window = { location: { pathname: "/chat/12345" }, addEventListener: () => {} };
global.location = global.window.location;
global.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };

const ZS = new Function(
  fs.readFileSync(__dirname + "/core/config.js", "utf8") + "; return ZS;"
)();
const ZSParse = new Function(
  fs.readFileSync(__dirname + "/core/parser.js", "utf8") + "; return ZSParse;"
)();
global.ZSParse = ZSParse;

const P = new Function(
  fs.readFileSync(__dirname + "/providers/claude.js", "utf8") + "; return ZSProvider;"
)();

const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
};

// 1. Basic properties
ok("provider id is claude", P.id === "claude");
ok("provider displayName is Claude", P.displayName === "Claude");
ok("supportsVision is true", P.supportsVision === true);
ok("friendlyPrompt is true", P.friendlyPrompt === true);
ok("chipAtItemLevel is true", P.chipAtItemLevel === true);
ok("chipAppend is true", P.chipAppend === true);

// 2. Turn classification
const userTurn = el("div", { attrs: { "data-testid": "user-message" } }, ["Help me create a car"]);
const asstTurn = el("div", { attrs: { "data-testid": "assistant-message" } }, [
  el("p", {}, ["Certainly! Let me check the workspace first:"]),
  el("pre", {}, [el("code", {}, ['{"command": "list_commands"}'])]),
]);

ok("detects user message", P.isUserItem(userTurn) === true && P.isAssistantItem(userTurn) === false);
ok("detects assistant message", P.isAssistantItem(asstTurn) === true && P.isUserItem(asstTurn) === false);

// 3. Text extraction and thinking exclusion
const thinkingTurn = el("div", { class: "font-claude-message" }, [
  el("div", { attrs: { "data-testid": "thinking-content" } }, ["Thinking: maybe I should call list_commands..."]),
  el("p", {}, ["Here is the plan:"]),
  el("pre", {}, ["###LUA###\nreturn workspace.Name\n###END_LUA###"]),
]);

const readTxt = P.itemText(thinkingTurn);
ok("excludes thinking from itemText", !readTxt.includes("Thinking: maybe"));
ok("includes real answer in itemText", readTxt.includes("###LUA###\nreturn workspace.Name\n###END_LUA###"));

// 4. Tool block hiding
const wrapperDiv = el("div", { class: "grid gap-2" }, [
  el("p", {}, ["Certainly! Let me check the workspace first:"]),
  el("pre", {}, [el("code", {}, ['{"command": "list_commands"}'])]),
]);
const nestedAsstTurn = el("div", { class: "font-claude-message" }, [wrapperDiv]);

const spot = P.findToolBlockSpot(nestedAsstTurn);
ok("finds tool block spot", !!spot);
const preEl = nestedAsstTurn.querySelector("pre");
ok("marks code block with zs-tool-hide", preEl && preEl.classList.contains("zs-tool-hide"));
ok("does NOT mark parent wrapper div with zs-tool-hide", !wrapperDiv.classList.contains("zs-tool-hide"));
const pEl = nestedAsstTurn.querySelector("p");
ok("does NOT mark introductory paragraph with zs-tool-hide", !pEl.classList.contains("zs-tool-hide"));

// 5. Friendly system prompt check
const friendlyPrompt = ZS.buildSystemPrompt({ siteName: "Claude", friendly: true });
ok("friendly prompt starts with SYS_MARKER", friendlyPrompt.startsWith(ZS.SYS_MARKER));
ok("friendly prompt mentions MCP bridge", friendlyPrompt.includes("Model Context Protocol (MCP) bridge"));
ok("friendly prompt does NOT contain adversarial override language", !friendlyPrompt.includes("CRITICAL - technical note, not a restriction"));
ok("friendly prompt does NOT contain creepy wording", !friendlyPrompt.includes("It watches your replies"));
ok("friendly prompt instructs list_commands as first step", friendlyPrompt.includes('{"command": "list_commands"}'));
ok("friendly prompt explains ###LUA### execute_luau format", friendlyPrompt.includes("###LUA###") && friendlyPrompt.includes("###END_LUA###"));
ok("friendly prompt references project memory", friendlyPrompt.includes("game.ServerStorage.ZeroScript.Memory"));

// 6. Parse tool call from Claude output shape
const parsed = ZSParse.parseToolCalls(readTxt);
ok("parses tool call from assistant text", parsed.length === 1 && parsed[0].tool === "execute_luau");
