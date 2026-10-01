import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  APPLICATION_MENUS,
  createApplicationMenuBarState,
  reduceApplicationMenuBar,
  type ApplicationMenu,
  type ApplicationMenuBarAction,
  type ApplicationMenuCommandId,
  type ApplicationMenuId,
} from '../state/applicationMenu';
import type { ApplicationMenuCommandState } from '../state/applicationMenuCommands';

export const APPLICATION_MENU_BAR_ID = 'application-menu-bar';

export const getApplicationMenuTriggerId = (menu: ApplicationMenuId): string => `application-menu-${menu}`;

export const getApplicationMenuDropdownId = (menu: ApplicationMenuId): string =>
  `${getApplicationMenuTriggerId(menu)}-menu`;

export const getApplicationMenuCommandDomId = (id: ApplicationMenuCommandId): string =>
  `application-menu-command-${id}`;

export interface ApplicationMenuBarViewProps {
  openMenu: ApplicationMenuId | null;
  commandState: ApplicationMenuCommandState;
  onToggleMenu: (menu: ApplicationMenuId) => void;
  onHoverMenu: (menu: ApplicationMenuId) => void;
  onDismiss: () => void;
  onRunCommand: (id: ApplicationMenuCommandId) => void;
  /** Lets the stateful wrapper detect clicks outside the bar. */
  rootRef?: React.Ref<HTMLElement>;
}

type MenuRow = ApplicationMenu['items'][number];

const isFocusableRow = (
  row: MenuRow,
  commandState: ApplicationMenuCommandState
): row is Extract<MenuRow, { kind: 'command' }> =>
  row.kind === 'command' && commandState.isEnabled(row.id);

/**
 * Pure presentation of the application menu bar.
 *
 * Keeping this free of document-level side effects lets the shell render it
 * directly in tests and keeps the open/close state machine in
 * `reduceApplicationMenuBar`, which is where its behaviour is verified.
 */
export const ApplicationMenuBarView: React.FC<ApplicationMenuBarViewProps> = ({
  openMenu,
  commandState,
  onToggleMenu,
  onHoverMenu,
  onDismiss,
  onRunCommand,
  rootRef,
}) => {
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const focusFirstRowRef = useRef(false);

  const menuIds = useMemo(() => APPLICATION_MENUS.map(menu => menu.id), []);

  useEffect(() => {
    if (!openMenu || !focusFirstRowRef.current) return;
    focusFirstRowRef.current = false;
    const menu = APPLICATION_MENUS.find(candidate => candidate.id === openMenu);
    if (!menu) return;
    const firstRow = menu.items.find(row => isFocusableRow(row, commandState));
    if (firstRow && firstRow.kind === 'command') {
      rowRefs.current.get(firstRow.id)?.focus();
    }
  }, [openMenu, commandState]);

  const focusTrigger = useCallback((index: number) => {
    const wrapped = (index + menuIds.length) % menuIds.length;
    triggerRefs.current[wrapped]?.focus();
    return menuIds[wrapped];
  }, [menuIds]);

  const handleTriggerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    menuId: ApplicationMenuId
  ) => {
    const index = menuIds.indexOf(menuId);
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (openMenu !== menuId) {
          focusFirstRowRef.current = true;
          onToggleMenu(menuId);
        }
        return;
      case 'ArrowRight': {
        event.preventDefault();
        const next = focusTrigger(index + 1);
        if (openMenu !== null) onToggleMenu(next);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        const previous = focusTrigger(index - 1);
        if (openMenu !== null) onToggleMenu(previous);
        return;
      }
      case 'Escape':
        if (openMenu !== null) {
          event.preventDefault();
          onDismiss();
        }
        return;
      default:
        return;
    }
  };

  const handleRowKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    menu: ApplicationMenu,
    rowId: ApplicationMenuCommandId
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      triggerRefs.current[menuIds.indexOf(menu.id)]?.focus();
      return;
    }

    const focusable = menu.items.filter(row => isFocusableRow(row, commandState));
    const currentIndex = focusable.findIndex(row => row.kind === 'command' && row.id === rowId);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (focusable.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = (currentIndex + step + focusable.length) % focusable.length;
      const next = focusable[nextIndex];
      if (next && next.kind === 'command') rowRefs.current.get(next.id)?.focus();
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      const next = focusTrigger(menuIds.indexOf(menu.id) + step);
      onToggleMenu(next);
    }
  };

  return (
    <header
      id={APPLICATION_MENU_BAR_ID}
      ref={rootRef}
      role="menubar"
      aria-label="Application"
      aria-orientation="horizontal"
      className="relative z-40 h-[30px] shrink-0 select-none bg-[#0a0a0b] border-b border-[#333336] flex items-stretch px-1 text-[11px] text-[#b0b0b0]"
    >
      {APPLICATION_MENUS.map((menu, index) => {
        const isOpen = openMenu === menu.id;
        return (
          <div key={menu.id} className="relative flex items-stretch">
            <button
              type="button"
              id={getApplicationMenuTriggerId(menu.id)}
              ref={element => {
                triggerRefs.current[index] = element;
              }}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              aria-controls={isOpen ? getApplicationMenuDropdownId(menu.id) : undefined}
              onClick={() => onToggleMenu(menu.id)}
              onPointerEnter={() => onHoverMenu(menu.id)}
              onKeyDown={event => handleTriggerKeyDown(event, menu.id)}
              className={`px-2.5 h-full inline-flex items-center transition-colors cursor-pointer ${
                isOpen
                  ? 'bg-[#2d2d30] text-white'
                  : 'hover:bg-[#1a1a1d] hover:text-white focus-visible:bg-[#1a1a1d] focus-visible:text-white'
              }`}
            >
              {menu.label}
            </button>

            {isOpen && (
              <div
                id={getApplicationMenuDropdownId(menu.id)}
                role="menu"
                aria-labelledby={getApplicationMenuTriggerId(menu.id)}
                className="absolute left-0 top-full z-50 min-w-[19rem] py-1 bg-[#1a1a1d] border border-[#333336] rounded-b-md shadow-2xl"
              >
                {menu.items.map((row, rowIndex) => {
                  if (row.kind === 'separator') {
                    return (
                      <div
                        key={`separator-${rowIndex}`}
                        role="separator"
                        className="my-1 h-px bg-[#333336]"
                      />
                    );
                  }

                  const enabled = commandState.isEnabled(row.id);
                  const checked = commandState.isChecked(row.id);
                  const isCheckable = checked !== undefined;
                  const { id, label, accelerator } = row;

                  return (
                    <button
                      key={id}
                      type="button"
                      id={getApplicationMenuCommandDomId(id)}
                      ref={element => {
                        if (element) rowRefs.current.set(id, element);
                        else rowRefs.current.delete(id);
                      }}
                      role={isCheckable ? 'menuitemradio' : 'menuitem'}
                      aria-checked={isCheckable ? checked : undefined}
                      aria-disabled={enabled ? undefined : true}
                      disabled={!enabled}
                      tabIndex={-1}
                      onClick={() => onRunCommand(id)}
                      onKeyDown={event => handleRowKeyDown(event, menu, id)}
                      className={`w-full px-3 py-1 flex items-center gap-3 text-left transition-colors ${
                        enabled
                          ? 'text-[#b0b0b0] hover:bg-[#2d2d30] hover:text-white cursor-pointer'
                          : 'text-[#555] cursor-default'
                      }`}
                    >
                      <span className="w-3 shrink-0 text-[#ff6e00] text-[10px]">
                        {isCheckable && checked ? '✓' : ''}
                      </span>
                      <span className="flex-1 truncate">{label}</span>
                      {accelerator && (
                        <kbd className="shrink-0 font-mono text-[9px] text-[#777] border border-[#333336] rounded px-1 py-px">
                          {accelerator}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </header>
  );
};

export interface ApplicationMenuDismissHandlers {
  handlePointerDown: (event: { target: unknown }) => void;
  handleKeyDown: (event: { key: string; stopPropagation?: () => void }) => void;
}

/**
 * The two document-level behaviours a desktop menu bar needs, extracted so they
 * can be verified without a DOM: a click outside the bar closes the dropdown, and
 * Escape closes it.
 *
 * Escape stops propagation on purpose. The Playlist and Piano Roll listen for
 * Escape on `window` to clear their selection; without this, closing the menu
 * would also silently drop the editor selection.
 */
export const createApplicationMenuDismissHandlers = (
  getContainer: () => { contains: (node: never) => boolean } | null,
  dismiss: () => void
): ApplicationMenuDismissHandlers => ({
  handlePointerDown(event) {
    const container = getContainer();
    if (container && event.target && container.contains(event.target as never)) return;
    dismiss();
  },
  handleKeyDown(event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation?.();
    dismiss();
  }
});

export interface ApplicationMenuBarProps {
  commandState: ApplicationMenuCommandState;
  onRunCommand: (id: ApplicationMenuCommandId) => void;
}

/**
 * Stateful shell wrapper.
 *
 * Owns only the open/close state and the two document-level behaviours a desktop
 * menu bar needs: clicking outside closes it, and Escape closes it. Escape stops
 * propagation so an open menu cannot also clear an editor selection.
 */
export const ApplicationMenuBar: React.FC<ApplicationMenuBarProps> = ({ commandState, onRunCommand }) => {
  const [state, setState] = React.useState(createApplicationMenuBarState);
  const containerRef = useRef<HTMLElement | null>(null);

  const dispatch = useCallback((action: ApplicationMenuBarAction) => {
    setState(current => reduceApplicationMenuBar(current, action));
  }, []);

  useEffect(() => {
    // Listeners are only live while a dropdown is open. `dismiss` is idempotent,
    // so this gating is about not reacting to stray clicks, not about correctness.
    if (state.openMenu === null) return;

    const dismiss = () => dispatch({ type: 'dismiss' });
    const { handlePointerDown, handleKeyDown } = createApplicationMenuDismissHandlers(
      () => containerRef.current as unknown as { contains: (node: never) => boolean } | null,
      dismiss
    );
    const onPointerDown = (event: PointerEvent) => handlePointerDown({ target: event.target });
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [state.openMenu, dispatch]);

  const runCommand = useCallback(
    (id: ApplicationMenuCommandId) => {
      dispatch({ type: 'dismiss' });
      onRunCommand(id);
    },
    [dispatch, onRunCommand]
  );

  return (
    <ApplicationMenuBarView
      rootRef={containerRef}
      openMenu={state.openMenu}
      commandState={commandState}
      onToggleMenu={menu => dispatch({ type: 'toggle', menu })}
      onHoverMenu={menu => dispatch({ type: 'hover', menu })}
      onDismiss={() => dispatch({ type: 'dismiss' })}
      onRunCommand={runCommand}
    />
  );
};

export default ApplicationMenuBar;
