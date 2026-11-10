import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const html = readFileSync(new URL("../views/importer.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

// Only the DOM operations used during discovery; no browser or dependencies.
class Element extends EventTarget {
  children = [];
  dataset = {};
  style = {};
  className = "";
  value = "";
  rawText = "";
  classList = {
    add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].join(" "); },
    remove: (...names) => { this.className = this.className.split(" ").filter(name => !names.includes(name)).join(" "); },
  };
  get textContent() { return this.rawText + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.rawText = String(value); this.children = []; }
  get firstChild() { return this.children[0]; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(name, value) { this[name] = value; }
  querySelector(selector) { return this.children.find(child => child.className.split(" ").includes(selector.slice(1))); }
  click() { this.dispatchEvent(new Event("click")); }
}

for (const locale of ["en", "zh-CN"]) {
  test(`opening discovers sources and rescan refreshes without importing (${locale})`, async () => {
    const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
    const document = Object.assign(new EventTarget(), {
      documentElement: new Element(), createElement: () => new Element(),
      getElementById: id => elements.get(id), querySelector: () => new Element(),
    });
    const calls = [];
    const window = { document, matchMedia: () => ({ matches: true }), pluginBridge: { on() {}, invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "app.locale") return locale;
      if (channel === "app.getAppearance") return { base: "light" };
      if (channel === "import.adapters") return [{ source: "sample", label: "Sample" }, { source: "zcode", label: "ZCode" }];
      if (channel === "import.customSources") return { count: 0, drivers: [], errors: [] };
      if (channel === "import.scanSource") return payload.source === "sample"
        ? { found: true, count: 1, error: { code: "PARTIAL_SOURCE", message: "EPERM: open /private/source.jsonl" } }
        : { found: false, count: 0 };
      throw new Error(`Unexpected Host call: ${channel}`);
    } } };
    const context = createContext({ window, document, navigator: { language: locale }, setTimeout, clearTimeout, console });
    runInContext(readFileSync(new URL("../lib/i18n.js", import.meta.url), "utf8"), context);
    runInContext(script, context);
    const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
    await settle();
    assert.equal(calls.filter(call => call.channel === "import.scanSource").length, 2, elements.get("status").textContent);
    const cards = elements.get("source-grid").children;
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent, locale === "en" ? /permission/i : /权限/);
    assert.match(cards[0].textContent, /1/);
    assert.doesNotMatch(cards[0].textContent, /\/private\/source/);
    assert.doesNotMatch(cards[1].textContent, /failed|失败/i);
    const button = elements.get("scan-btn");
    assert.equal(button.disabled, false);
    button.click();
    await settle();
    assert.equal(calls.filter(call => call.channel === "import.scanSource").length, 4);
    assert.ok(calls.filter(call => call.channel === "import.scanSource").slice(2).every(call => call.payload.full === true));
    assert.equal(button.disabled, false);
    assert.ok(calls.every(call => !/import\.(commit|project)$/.test(call.channel)));
  });
}
