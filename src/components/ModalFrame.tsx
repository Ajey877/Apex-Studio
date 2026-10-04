import React, { useEffect, useRef } from 'react';

/**
 * UI Milestone 1C — Step 4: shared modal/dialog frame.
 *
 * Every legacy modal keeps its own overlay id, overlay classes, panel markup
 * (`#…-modal > div`), title text and `isOpen` / `onClose` wiring. ModalFrame
 * only owns the parts that must behave identically everywhere:
 *   - `role="dialog"` + `aria-modal="true"` on the overlay,
 *   - the accessible name, taken from the modal's existing title via
 *     `aria-labelledby`,
 *   - Escape closes the dialog without reaching the global shell shortcuts,
 *   - the opener is captured, focus moves into the dialog on open, Tab and
 *     Shift+Tab stay inside it, and focus returns to the opener on close.
 *
 * There is intentionally no backdrop-click dismissal: closing a dialog is an
 * explicit act (Escape or a close control), so a stray click can never discard
 * work.
 *
 * The focus/keyboard helpers below are pure and DOM-agnostic on purpose: the
 * tsx suite has no jsdom, so every behaviour is covered through small injected
 * fakes while the component passes the real document/elements at runtime.
 */

/** Pre-filter for focusable descendants; visibility/disabled filtering happens after. */
export const MODAL_FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, audio[controls], video[controls], [contenteditable="true"], [tabindex]';

/** Matches every dialog surface the App-level hotkey guard must respect. */
export const MODAL_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

export const DIALOG_ESCAPE_KEY = 'Escape';

/** Minimal structural view of a focusable element; real Elements satisfy this. */
export interface FocusTrapCandidate {
  focus: () => void;
  readonly tabIndex?: number | undefined;
  readonly disabled?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  getAttribute?: ((name: string) => string | null) | undefined;
  getClientRects?: (() => ArrayLike<unknown>) | undefined;
}

/**
 * True when the candidate can actually receive keyboard focus: enabled,
 * rendered, tabbable and exposed to assistive technology.
 */
export function isTrapFocusable(candidate: FocusTrapCandidate | null | undefined): boolean {
  if (!candidate) return false;
  if (candidate.disabled) return false;
  if (candidate.hidden) return false;
  if (typeof candidate.tabIndex === 'number' && candidate.tabIndex < 0) return false;
  if (typeof candidate.getAttribute === 'function' && candidate.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  if (typeof candidate.getClientRects === 'function' && candidate.getClientRects().length === 0) {
    return false;
  }
  return true;
}

/**
 * Tab / Shift+Tab containment over a pre-collected descendant list. Hidden and
 * disabled entries are skipped, and focus wraps at both ends so it can never
 * leave the dialog. Returns null when the dialog holds no tabbable element.
 */
export function nextTrapFocus<T extends FocusTrapCandidate>(
  elements: readonly T[],
  activeElement: unknown,
  shiftKey: boolean
): T | null {
  const items = elements.filter(isTrapFocusable);
  if (items.length === 0) return null;
  const index = items.indexOf(activeElement as T);
  if (index === -1) return shiftKey ? items[items.length - 1] : items[0];
  if (items.length === 1) return items[0];
  if (shiftKey) return index === 0 ? items[items.length - 1] : items[index - 1];
  return index === items.length - 1 ? items[0] : items[index + 1];
}

/** Minimal structural view of the element that opened the dialog. */
export interface DialogOpener {
  focus: () => void;
  readonly isConnected?: boolean | undefined;
}

const asDialogOpener = (value: unknown): DialogOpener | null => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  if (typeof (value as { focus?: unknown }).focus !== 'function') return null;
  return value as DialogOpener;
};

/** Captures the focus trigger so it can be restored when the dialog closes. */
export function captureDialogOpener(
  doc: { readonly activeElement?: unknown } | null | undefined
): DialogOpener | null {
  if (!doc) return null;
  return asDialogOpener(doc.activeElement);
}

/**
 * Returns focus to the opener. A no-op (false) when there is no opener or it
 * left the document while the dialog was open.
 */
export function restoreDialogFocus(opener: DialogOpener | null | undefined): boolean {
  if (!opener) return false;
  if (opener.isConnected === false) return false;
  opener.focus();
  return true;
}

/** Initial focus: the first tabbable descendant, else the dialog itself. */
export function resolveDialogInitialFocus<T extends FocusTrapCandidate>(
  dialog: T,
  descendants: readonly T[]
): T {
  const first = descendants.filter(isTrapFocusable)[0];
  return first === undefined ? dialog : first;
}

/** Minimal structural view of the key event the dialog Escape handler needs. */
export interface DialogEscapeEvent {
  readonly key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function isDialogEscapeKey(key: string): boolean {
  return key === DIALOG_ESCAPE_KEY;
}

/**
 * Shared Escape handling, attached to the dialog overlay. Stopping
 * propagation is what keeps Escape on the active dialog: the event bubbles
 * from the focused element, the innermost overlay handles it first, and outer
 * dialogs — plus the window-level shell shortcuts in App — never see it.
 * Returns true only when the key actually dismissed the dialog.
 */
export function handleDialogEscapeKey(event: DialogEscapeEvent, onClose: () => void): boolean {
  if (!isDialogEscapeKey(event.key)) return false;
  event.preventDefault();
  event.stopPropagation();
  onClose();
  return true;
}

/**
 * True while any dialog surface (Step 4 `dialog` or the intact
 * `ProjectReplaceConfirmModal` alertdialog) is mounted. App consults this in
 * its window keydown handler so shell shortcuts stay inert behind a modal.
 */
export function hasOpenModalDialog(
  doc: { querySelector: (selectors: string) => unknown } | null | undefined
): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  return Boolean(doc.querySelector(MODAL_DIALOG_SELECTOR));
}

// Mounted dialog ids in open order (last entry is the topmost dialog). Client
// only: registration happens inside effects, so server rendering stays pure.
const mountedModalIds: string[] = [];

/**
 * Tracks a mounted dialog id. Returns false for a duplicate mount — two live
 * dialogs must never share an id — without disturbing the existing entry.
 */
export function registerModalId(id: string): boolean {
  if (mountedModalIds.includes(id)) return false;
  mountedModalIds.push(id);
  return true;
}

export function unregisterModalId(id: string): void {
  const index = mountedModalIds.indexOf(id);
  if (index !== -1) mountedModalIds.splice(index, 1);
}

export function getMountedModalIds(): readonly string[] {
  return [...mountedModalIds];
}

/** The topmost dialog of a stack is the last id that was registered. */
export function isTopmostModalId(id: string): boolean {
  return mountedModalIds.length > 0 && mountedModalIds[mountedModalIds.length - 1] === id;
}

export interface ModalFrameProps {
  /** The modal's existing overlay id, preserved verbatim. Modals that never
      had an overlay id keep having none. */
  id?: string;
  /** Id of the modal's existing title element; sources the accessible name. */
  labelledBy: string;
  /** The modal's existing onClose wiring. */
  onClose: () => void;
  /**
   * Whether the frame may be dismissed right now (Escape). Defaults to true.
   *
   * A modal that owns a long-running operation — the export dialog while a render
   * holds the engine's render lease — sets this to false so Escape cannot discard
   * work that is still in flight. Dismissal is then refused instead of silently
   * accepted: the dialog (and the finished export) can only be closed once the
   * operation finished.
   */
  dismissible?: boolean;
  /** The modal's existing overlay classes, preserved verbatim. */
  className?: string;
  /** The modal's existing panel markup — stays the direct child div. */
  children?: React.ReactNode;
}

export const ModalFrame: React.FC<ModalFrameProps> = ({ id, labelledBy, onClose, dismissible = true, className, children }) => {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<DialogOpener | null>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    dismissibleRef.current = dismissible;
  }, [dismissible]);

  // Mount: register the id, capture the opener, move focus into the dialog.
  // Unmount: unregister the id, restore focus to the opener.
  useEffect(() => {
    if (typeof id === 'string' && id.length > 0 && !registerModalId(id)) {
      console.warn(
        `[ModalFrame] duplicate modal id "${id}" mounted; dialog ids must stay unique.`
      );
    }
    openerRef.current = captureDialogOpener(typeof document === 'undefined' ? undefined : document);
    const overlay = overlayRef.current;
    if (overlay) {
      const descendants = Array.from(overlay.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR));
      resolveDialogInitialFocus(overlay, descendants).focus();
    }
    return () => {
      if (typeof id === 'string' && id.length > 0) unregisterModalId(id);
      restoreDialogFocus(openerRef.current);
      openerRef.current = null;
    };
  }, [id]);

  // Tab / Shift+Tab containment while the dialog is open.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const handleTabKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const descendants = Array.from(overlay.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR));
      const next = nextTrapFocus(descendants, document.activeElement, event.shiftKey);
      event.preventDefault();
      (next ?? overlay).focus();
    };
    overlay.addEventListener('keydown', handleTabKey);
    return () => overlay.removeEventListener('keydown', handleTabKey);
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // A modal that owns work still in flight refuses the dismissal instead of
    // accepting it: nothing is consumed, the shell's global hotkeys stay inert
    // while the dialog is mounted, and the close wiring never runs.
    if (!dismissibleRef.current) return;
    handleDialogEscapeKey(event, onCloseRef.current);
  };

  return (
    <div
      id={id}
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={className ? `apex-modal-overlay ${className}` : 'apex-modal-overlay'}
    >
      {children}
    </div>
  );
};
