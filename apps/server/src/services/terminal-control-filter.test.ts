import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeReplayForTerminal,
  stripTerminalResponsePayload,
} from "./terminal-control-filter.js";

test("strip terminal device-attribute responses from stdin payloads", () => {
  const sanitized = stripTerminalResponsePayload("\u001b[0;276;0c");

  assert.equal(sanitized, "");
});

test("keep normal keyboard escape sequences intact", () => {
  const sanitized = stripTerminalResponsePayload("\u001b[A");

  assert.equal(sanitized, "\u001b[A");
});

test("keep CPR row and column reports intact for interactive prompts", () => {
  const sanitized = stripTerminalResponsePayload("\u001b[12;42R");

  assert.equal(sanitized, "\u001b[12;42R");
});

test("sanitize replay removes window and cursor report sequences", () => {
  const replay =
    "prompt> \u001b[>cprompt redraw\u001b[6n\u001b[18t\u001b[12;42Rstill here";

  const sanitized = sanitizeReplayForTerminal(replay);

  assert.equal(sanitized, "prompt> prompt redrawstill here");
});
