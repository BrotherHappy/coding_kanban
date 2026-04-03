import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clampTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  loadTerminalSettings,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  saveTerminalSettings,
  TERMINAL_SETTINGS_STORAGE_KEY,
} from "./terminal-settings.js";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
  clear: () => store.clear(),
};

describe("terminal-settings", () => {
  it("returns defaults when nothing saved", () => {
    store.clear();
    const settings = loadTerminalSettings();
    assert.equal(settings.fontSize, DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("persists and loads a clamped font size", () => {
    store.clear();
    saveTerminalSettings({ fontSize: 12.4 });
    const settings = loadTerminalSettings();
    assert.equal(settings.fontSize, 12);
  });

  it("clamps low values to the minimum", () => {
    assert.equal(clampTerminalFontSize(1), MIN_TERMINAL_FONT_SIZE);
  });

  it("clamps high values to the maximum", () => {
    assert.equal(clampTerminalFontSize(99), MAX_TERMINAL_FONT_SIZE);
  });

  it("falls back gracefully on corrupt data", () => {
    store.set(TERMINAL_SETTINGS_STORAGE_KEY, "not-json{{{");
    const settings = loadTerminalSettings();
    assert.equal(settings.fontSize, DEFAULT_TERMINAL_FONT_SIZE);
  });
});
