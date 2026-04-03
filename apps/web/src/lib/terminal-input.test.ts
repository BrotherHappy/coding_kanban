import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stripTerminalResponsePayload } from "./terminal-input.js";

describe("stripTerminalResponsePayload", () => {
  it("drops device-attribute responses before they are sent back to the PTY", () => {
    assert.equal(stripTerminalResponsePayload("\u001b[0;276;0c"), "");
  });

  it("keeps normal arrow-key input intact", () => {
    assert.equal(stripTerminalResponsePayload("\u001b[A"), "\u001b[A");
  });

  it("drops CPR row and column reports so TerminalView can forward a single controlled reply", () => {
    assert.equal(stripTerminalResponsePayload("\u001b[12;42R"), "");
  });
});
