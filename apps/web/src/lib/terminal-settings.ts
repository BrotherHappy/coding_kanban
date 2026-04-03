export interface TerminalSettings {
  fontSize: number;
}

export const TERMINAL_SETTINGS_STORAGE_KEY = "agent-console-terminal-settings";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 18;

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
};

export function clampTerminalFontSize(fontSize: number): number {
  if (!Number.isFinite(fontSize)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }

  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)),
  );
}

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(TERMINAL_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_TERMINAL_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<TerminalSettings>;
    return {
      fontSize: clampTerminalFontSize(
        parsed.fontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
      ),
    };
  } catch {
    return DEFAULT_TERMINAL_SETTINGS;
  }
}

export function saveTerminalSettings(settings: TerminalSettings): void {
  try {
    localStorage.setItem(
      TERMINAL_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        fontSize: clampTerminalFontSize(settings.fontSize),
      }),
    );
  } catch {
    // Storage full or unavailable — silently ignore
  }
}
