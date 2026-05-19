import { useEffect } from "react";

export interface ShortcutOptions {
  /** When false, the handler is not registered. */
  enabled?: boolean;
  /** When true, prevents default browser/system behavior on match. */
  preventDefault?: boolean;
  /** When true, allows firing while focus is inside an editable element. */
  allowInEditable?: boolean;
}

interface ParsedCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(spec: string): ParsedCombo {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase());
  const combo: ParsedCombo = { mod: false, shift: false, alt: false, key: "" };
  for (const part of parts) {
    if (part === "mod" || part === "cmd" || part === "ctrl") combo.mod = true;
    else if (part === "shift") combo.shift = true;
    else if (part === "alt" || part === "option") combo.alt = true;
    else combo.key = part;
  }
  return combo;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function matches(event: KeyboardEvent, combo: ParsedCombo): boolean {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  if (combo.mod !== modPressed) return false;
  if (combo.shift !== event.shiftKey) return false;
  if (combo.alt !== event.altKey) return false;

  const key = event.key.toLowerCase();
  const code = event.code.toLowerCase();
  // Special aliases
  if (combo.key === "enter") return key === "enter";
  if (combo.key === "escape" || combo.key === "esc") return key === "escape";
  if (combo.key === "backtick" || combo.key === "`") return key === "`" || code === "backquote";
  if (combo.key === "period" || combo.key === ".") return key === ".";
  if (combo.key === "comma" || combo.key === ",") return key === ",";
  if (combo.key === "slash" || combo.key === "/") return key === "/";
  if (combo.key.length === 1) return key === combo.key;
  return key === combo.key;
}

export function useShortcut(
  spec: string,
  handler: (event: KeyboardEvent) => void,
  options: ShortcutOptions = {},
): void {
  const { enabled = true, preventDefault = true, allowInEditable = false } = options;

  useEffect(() => {
    if (!enabled) return;
    const combo = parseCombo(spec);
    if (!combo.key) return;

    const listener = (event: KeyboardEvent): void => {
      if (!allowInEditable && isEditableTarget(event.target)) return;
      if (!matches(event, combo)) return;
      if (preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }
      handler(event);
    };

    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [spec, enabled, preventDefault, allowInEditable, handler]);
}
