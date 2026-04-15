import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import { buildTerminalWebSocketUrl } from "../lib/api";
import { stripTerminalResponsePayload } from "../lib/terminal-input";

interface TerminalViewProps {
  agentSessionId: string;
  interactive?: boolean;
  suspended?: boolean;
  forceTmuxMouseCapture?: boolean;
  active?: boolean;
  fontSize?: number;
}

type TerminalContainer = HTMLDivElement & {
  __xterm?: Terminal;
};

interface TerminalInputOwner {
  token: symbol;
  priority: number;
}

interface TerminalControlFrame {
  __agentOrchestrator: "terminal-control";
  event: "replay" | "replay-complete";
  data?: string;
}

interface TerminalGeometry {
  cols: number;
  rows: number;
  width: number;
  height: number;
}

interface PendingMouseReplay {
  clientX: number;
  clientY: number;
  button: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface XtermInternalCore {
  coreMouseService?: {
    triggerMouseEvent: (event: {
      col: number;
      row: number;
      x: number;
      y: number;
      button: number;
      action: 0 | 1;
      ctrl: boolean;
      alt: boolean;
      shift: boolean;
    }) => boolean;
  };
  screenElement?: HTMLElement;
  _renderService?: {
    dimensions?: {
      css?: {
        cell?: {
          width?: number;
          height?: number;
        };
      };
    };
  };
}

interface XtermBufferCursor {
  cursorX?: number;
  cursorY?: number;
}

const DEFAULT_PREVIEW_GEOMETRY: TerminalGeometry = {
  cols: 120,
  rows: 30,
  width: 1180,
  height: 760,
};
const DEFAULT_TERMINAL_FONT_FAMILY =
  '"IBM Plex Mono", "SFMono-Regular", monospace';
const TMUX_TERMINAL_FONT_FAMILY =
  '"DejaVu Sans Mono", "Noto Sans Mono", "Liberation Mono", monospace';

const previewGeometryCache = new Map<string, TerminalGeometry>();
const terminalInputOwners = new Map<string, TerminalInputOwner>();

function countCursorPositionQueries(payload: string): number {
  return payload.match(/\u001b\[(?:\?)?6n/g)?.length ?? 0;
}

function buildCursorPositionResponse(term: Terminal): string {
  const buffer = (
    term as Terminal & {
      buffer?: {
        active?: XtermBufferCursor;
      };
    }
  ).buffer?.active;
  const row = (buffer?.cursorY ?? 0) + 1;
  const col = (buffer?.cursorX ?? 0) + 1;

  return `\u001b[${row};${col}R`;
}

function encodeSgrMouseFrame(options: {
  button: number;
  col: number;
  row: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  release?: boolean;
}): string {
  let code = options.button;

  if (options.shiftKey) {
    code += 4;
  }
  if (options.altKey) {
    code += 8;
  }
  if (options.ctrlKey) {
    code += 16;
  }

  return `\u001b[<${code};${options.col + 1};${options.row + 1}${options.release ? "m" : "M"}`;
}

export function TerminalView({
  agentSessionId,
  interactive = true,
  suspended = false,
  forceTmuxMouseCapture = false,
  active = true,
  fontSize = 14,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const activeRef = useRef(active);
  const scheduleFitRef = useRef<(() => void) | null>(null);
  const flushResizeRef = useRef<(() => void) | null>(null);
  const scheduleFocusRef = useRef<((unlockInput?: boolean) => void) | null>(
    null,
  );
  const flushPendingMouseReplayRef = useRef<(() => void) | null>(null);

  activeRef.current = active;

  useEffect(() => {
    if (!interactive || !active) {
      return;
    }

    scheduleFitRef.current?.();
    flushResizeRef.current?.();
    scheduleFocusRef.current?.(true);
    flushPendingMouseReplayRef.current?.();
  }, [active, interactive]);

  useEffect(() => {
    if (suspended) {
      return;
    }

    const container = containerRef.current as TerminalContainer | null;
    const stage = interactive
      ? container
      : (stageRef.current as HTMLDivElement | null);
    if (!container || !stage) return;

    const timeoutIds: number[] = [];
    const animationFrameIds: number[] = [];
    const isPreview = !interactive;
    const ownerToken = Symbol(agentSessionId);
    const ownerPriority = interactive ? 2 : 1;
    let handleMouseDownCapture: ((event: MouseEvent) => void) | null = null;
    let handlePointerDownCapture: ((event: PointerEvent) => void) | null = null;
    let handleWindowFocus: (() => void) | null = null;
    let disposed = false;
    let closeAfterOpen = false;
    let pendingMouseReplay: PendingMouseReplay | null = null;

    const ensureInputOwner = () => {
      const currentOwner = terminalInputOwners.get(agentSessionId);
      if (
        !currentOwner ||
        currentOwner.token === ownerToken ||
        currentOwner.priority <= ownerPriority
      ) {
        terminalInputOwners.set(agentSessionId, {
          token: ownerToken,
          priority: ownerPriority,
        });
        return true;
      }

      return false;
    };

    ensureInputOwner();

    const cachePreviewGeometry = (cols: number, rows: number) => {
      if (isPreview) {
        return;
      }

      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) {
        return;
      }

      previewGeometryCache.set(agentSessionId, {
        cols,
        rows,
        width,
        height,
      });
    };

    const applyPreviewLayout = () => {
      if (!isPreview) {
        return;
      }

      const geometry =
        previewGeometryCache.get(agentSessionId) ?? DEFAULT_PREVIEW_GEOMETRY;
      const scale = Math.min(
        container.clientWidth / geometry.width || 1,
        container.clientHeight / geometry.height || 1,
      );

      stage.style.width = `${geometry.width}px`;
      stage.style.height = `${geometry.height}px`;
      stage.style.left = "50%";
      stage.style.top = "50%";
      stage.style.transformOrigin = "center center";
      stage.style.transform = `translate(-50%, -50%) scale(${Math.max(scale, 0.01)})`;
    };

    const term = new Terminal({
      customGlyphs: !forceTmuxMouseCapture,
      cursorBlink: interactive,
      fontSize,
      fontFamily: forceTmuxMouseCapture
        ? TMUX_TERMINAL_FONT_FAMILY
        : DEFAULT_TERMINAL_FONT_FAMILY,
      lineHeight: 1,
      letterSpacing: 0,
      rescaleOverlappingGlyphs: !forceTmuxMouseCapture,
      theme: {
        background: "#0e1217",
        foreground: "#f4f1ea",
        cursor: "#ff8f1f",
        selectionBackground: "rgba(255, 152, 0, 0.3)",
      },
      scrollback: 5000,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    applyPreviewLayout();
    term.open(stage);
    container.__xterm = term;

    termRef.current = term;
    fitRef.current = fitAddon;

    const focusInteractiveTerminal = (unlockInput = false) => {
      if (!interactive || !activeRef.current) {
        return;
      }

      if (unlockInput) {
        term.options.disableStdin = false;
      }
      ensureInputOwner();
      term.focus();
    };

    const currentMouseTrackingMode = () =>
      (
        term as Terminal & {
          modes?: {
            mouseTrackingMode?: string;
          };
        }
      ).modes?.mouseTrackingMode ?? "none";

    const queuePendingMouseReplay = (event: MouseEvent | PointerEvent) => {
      if (!interactive || currentMouseTrackingMode() !== "none") {
        return;
      }

      pendingMouseReplay = {
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      };
    };

    const flushPendingMouseReplay = () => {
      if (!interactive || !pendingMouseReplay) {
        return;
      }

      const core = (
        term as Terminal & {
          _core?: XtermInternalCore;
        }
      )._core;
      const screen = core?.screenElement;
      const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 0;
      const cellHeight =
        core?._renderService?.dimensions?.css?.cell?.height ?? 0;

      if (
        !(screen instanceof HTMLElement) ||
        !core?.coreMouseService ||
        cellWidth <= 0 ||
        cellHeight <= 0
      ) {
        return;
      }

      const replay = pendingMouseReplay;
      const rect = screen.getBoundingClientRect();
      const x = replay.clientX - rect.left;
      const y = replay.clientY - rect.top;
      const col = Math.max(
        0,
        Math.min(term.cols - 1, Math.floor(x / cellWidth)),
      );
      const row = Math.max(
        0,
        Math.min(term.rows - 1, Math.floor(y / cellHeight)),
      );

      if (
        currentMouseTrackingMode() === "none" &&
        forceTmuxMouseCapture &&
        ws?.readyState === WebSocket.OPEN &&
        ensureInputOwner()
      ) {
        ws.send(
          encodeSgrMouseFrame({
            button: replay.button,
            col,
            row,
            ctrlKey: replay.ctrlKey,
            altKey: replay.altKey,
            shiftKey: replay.shiftKey,
          }),
        );
        ws.send(
          encodeSgrMouseFrame({
            button: replay.button,
            col,
            row,
            ctrlKey: replay.ctrlKey,
            altKey: replay.altKey,
            shiftKey: replay.shiftKey,
            release: true,
          }),
        );
        pendingMouseReplay = null;
        return;
      }

      if (currentMouseTrackingMode() === "none") {
        return;
      }

      const triggerMouseEvent = core.coreMouseService.triggerMouseEvent.bind(
        core.coreMouseService,
      );

      const mouseEventBase = {
        col,
        row,
        x,
        y,
        button: replay.button,
        ctrl: replay.ctrlKey,
        alt: replay.altKey,
        shift: replay.shiftKey,
      };

      const didSendDown = triggerMouseEvent({
        ...mouseEventBase,
        action: 1,
      });
      const didSendUp = triggerMouseEvent({
        ...mouseEventBase,
        action: 0,
      });

      if (didSendDown || didSendUp) {
        pendingMouseReplay = null;
      }
    };

    const scheduleFocusInteractiveTerminal = (unlockInput = false) => {
      if (!interactive || !activeRef.current) {
        return;
      }

      focusInteractiveTerminal(unlockInput);

      const frameId = window.requestAnimationFrame(() => {
        if (!disposed) {
          focusInteractiveTerminal(unlockInput);
        }
      });
      animationFrameIds.push(frameId);

      timeoutIds.push(
        window.setTimeout(() => {
          if (!disposed) {
            focusInteractiveTerminal(unlockInput);
          }
        }, 0),
      );

      timeoutIds.push(
        window.setTimeout(() => {
          if (!disposed) {
            focusInteractiveTerminal(unlockInput);
          }
        }, 32),
      );
    };

    const wsUrl = buildTerminalWebSocketUrl(agentSessionId);
    let ws: WebSocket | null = null;
    let replayComplete = false;
    const connectTimeoutId = window.setTimeout(() => {
      if (disposed) {
        return;
      }

      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          handleTerminalFrame(event.data);
        } else if (event.data instanceof Blob) {
          event.data.text().then((text) => handleTerminalFrame(text));
        }
      };

      ws.onopen = () => {
        if (disposed || closeAfterOpen) {
          ws?.close();
          return;
        }

        flushResize();
        scheduleFit();
        scheduleFocusInteractiveTerminal();
        flushPendingMouseReplay();
        timeoutIds.push(window.setTimeout(flushPendingMouseReplay, 0));
        timeoutIds.push(window.setTimeout(flushPendingMouseReplay, 32));
      };

      ws.onclose = () => {
        if (disposed) {
          return;
        }

        term.write("\r\n\x1b[33m[连接已断开]\x1b[0m\r\n");
      };
    }, 0);

    const flushResize = () => {
      if (isPreview || (interactive && !activeRef.current)) {
        return;
      }

      const size = pendingResizeRef.current;
      if (!size || ws?.readyState !== WebSocket.OPEN) {
        return;
      }

      ws.send(
        JSON.stringify({
          type: "resize",
          cols: size.cols,
          rows: size.rows,
        }),
      );
    };

    const fitTerminal = () => {
      try {
        applyPreviewLayout();
        fitAddon.fit();
        if (term.cols > 0 && term.rows > 0) {
          cachePreviewGeometry(term.cols, term.rows);
        }
        term.refresh(0, Math.max(term.rows - 1, 0));
      } catch {
        /* container may not be measurable yet */
      }
    };

    const scheduleFit = () => {
      if (interactive && !activeRef.current) {
        return;
      }

      const frameId = window.requestAnimationFrame(() => {
        fitTerminal();

        const nestedFrameId = window.requestAnimationFrame(() => {
          fitTerminal();
        });
        animationFrameIds.push(nestedFrameId);
      });
      animationFrameIds.push(frameId);

      timeoutIds.push(window.setTimeout(fitTerminal, 32));
      timeoutIds.push(window.setTimeout(fitTerminal, 96));
    };

    scheduleFitRef.current = scheduleFit;
    flushResizeRef.current = flushResize;
    scheduleFocusRef.current = scheduleFocusInteractiveTerminal;
    flushPendingMouseReplayRef.current = flushPendingMouseReplay;

    const enableTerminalInput = () => {
      if (replayComplete) {
        return;
      }

      replayComplete = true;
      term.options.disableStdin = false;
      scheduleFocusInteractiveTerminal();
      flushPendingMouseReplay();
    };

    const forwardCursorPositionReplies = (payload: string) => {
      const queryCount = countCursorPositionQueries(payload);
      if (queryCount === 0) {
        return;
      }

      if (ws?.readyState !== WebSocket.OPEN || !ensureInputOwner()) {
        return;
      }

      const response = buildCursorPositionResponse(term);
      for (let index = 0; index < queryCount; index += 1) {
        ws.send(response);
      }
    };

    const handleTerminalFrame = (payload: string) => {
      try {
        const parsed = JSON.parse(payload) as TerminalControlFrame;
        if (parsed.__agentOrchestrator !== "terminal-control") {
          enableTerminalInput();
          term.write(payload);
          forwardCursorPositionReplies(payload);
          flushPendingMouseReplay();
          return;
        }

        if (parsed.event === "replay" && typeof parsed.data === "string") {
          term.write(parsed.data);
          forwardCursorPositionReplies(parsed.data);
          flushPendingMouseReplay();
          return;
        }

        if (parsed.event === "replay-complete") {
          enableTerminalInput();
        }
        return;
      } catch {
        enableTerminalInput();
        term.write(payload);
        forwardCursorPositionReplies(payload);
        flushPendingMouseReplay();
      }
    };

    term.onData((data) => {
      const sanitized = stripTerminalResponsePayload(data);
      if (!sanitized) {
        return;
      }

      if (ws?.readyState === WebSocket.OPEN && ensureInputOwner()) {
        ws.send(sanitized);
      }
    });

    term.onBinary((data) => {
      const sanitized = stripTerminalResponsePayload(data);
      if (!sanitized) {
        return;
      }

      if (ws?.readyState === WebSocket.OPEN && ensureInputOwner()) {
        ws.send(
          JSON.stringify({
            type: "binary",
            data: btoa(sanitized),
          }),
        );
      }
    });

    if (interactive) {
      term.attachCustomWheelEventHandler((event) => {
        focusInteractiveTerminal(true);
        event.stopPropagation();
        return true;
      });

      handlePointerDownCapture = (event) => {
        queuePendingMouseReplay(event);
        focusInteractiveTerminal(true);
        flushPendingMouseReplay();
      };

      handleMouseDownCapture = (event) => {
        if (!pendingMouseReplay) {
          queuePendingMouseReplay(event);
        }
        focusInteractiveTerminal(true);
        flushPendingMouseReplay();
      };

      handleWindowFocus = () => {
        scheduleFocusInteractiveTerminal();
      };

      container.addEventListener("pointerdown", handlePointerDownCapture, true);
      container.addEventListener("mousedown", handleMouseDownCapture, true);
      window.addEventListener("focus", handleWindowFocus);
      scheduleFocusInteractiveTerminal();
    }

    term.onResize(({ cols, rows }) => {
      if (!isPreview) {
        if (activeRef.current) {
          cachePreviewGeometry(cols, rows);
          pendingResizeRef.current = { cols, rows };
          flushResize();
          flushPendingMouseReplay();
        }
      }
    });

    scheduleFit();

    if (typeof document !== "undefined" && "fonts" in document) {
      void document.fonts.ready.then(() => {
        scheduleFit();
      });
    }

    const handleWindowResize = () => {
      scheduleFit();
    };
    window.addEventListener("resize", handleWindowResize);

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();
      if (handlePointerDownCapture) {
        container.removeEventListener(
          "pointerdown",
          handlePointerDownCapture,
          true,
        );
      }
      if (handleMouseDownCapture) {
        container.removeEventListener(
          "mousedown",
          handleMouseDownCapture,
          true,
        );
      }
      if (handleWindowFocus) {
        window.removeEventListener("focus", handleWindowFocus);
      }
      window.clearTimeout(connectTimeoutId);
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      for (const animationFrameId of animationFrameIds) {
        window.cancelAnimationFrame(animationFrameId);
      }

      const currentOwner = terminalInputOwners.get(agentSessionId);
      if (currentOwner?.token === ownerToken) {
        terminalInputOwners.delete(agentSessionId);
      }

      if (ws?.readyState === WebSocket.CONNECTING) {
        closeAfterOpen = true;
      } else if (ws?.readyState === WebSocket.OPEN) {
        ws.close();
      }

      term.dispose();
      delete container.__xterm;
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
      pendingResizeRef.current = null;
      scheduleFitRef.current = null;
      flushResizeRef.current = null;
      scheduleFocusRef.current = null;
      flushPendingMouseReplayRef.current = null;
    };
  }, [agentSessionId, forceTmuxMouseCapture, interactive, suspended]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }

    term.options.fontSize = fontSize;
    scheduleFitRef.current?.();
    flushResizeRef.current?.();
  }, [fontSize]);

  return (
    <div
      ref={containerRef}
      className={`terminal-view ${interactive ? "terminal-view-live" : "terminal-view-preview"}`}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {!interactive && !suspended && (
        <div ref={stageRef} className="terminal-view-stage" />
      )}
    </div>
  );
}
