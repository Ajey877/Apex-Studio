import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AudioWaveform,
  Blocks,
  ChevronDown,
  Disc3,
  FolderArchive,
  Gauge,
  GitBranch,
  Grid3x3,
  Layers,
  MicVocal,
  Monitor,
  Scissors,
  Sliders,
  Timer,
  Users,
  Waves,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { createApplicationMenuDismissHandlers } from './ApplicationMenuBar';

/**
 * UI Milestone 1C — the transport tool overflow.
 *
 * The transport used to render ~20 tool chips in a single scrollable strip with
 * the scrollbar hidden, so on a laptop most tools were simply invisible. The
 * tools are now split into:
 *
 *   - a small, deliberate core set that stays in the header (see TransportBar),
 *   - this overflow menu, which holds the specialised tools grouped by purpose.
 *
 * Nothing was removed: the same elements, the same ids and the same handlers are
 * still rendered, only the presentation changed. The menu reuses the audited 1B
 * dismiss behaviour, including the deliberate `stopPropagation` on Escape, so
 * closing the tools menu can never also clear a Playlist or Piano Roll selection.
 */

export const TRANSPORT_TOOLS_TRIGGER_ID = 'fl-tools-menu-btn';
export const TRANSPORT_TOOLS_MENU_ID = 'fl-tools-menu';

/** Handlers the transport already receives; a missing handler renders disabled. */
export interface TransportToolHandlers {
  samples?: () => void;
  wavetable?: () => void;
  keymap?: () => void;
  vocalTuner?: () => void;
  timeFx?: () => void;
  warp?: () => void;
  slicer?: () => void;
  comping?: () => void;
  eq?: () => void;
  mastering?: () => void;
  sidechain?: () => void;
  macros?: () => void;
  midiLearn?: () => void;
  projectBundle?: () => void;
  desktopApp?: () => void;
  collab?: () => void;
}

type TransportToolHandlerKey = keyof TransportToolHandlers;

export interface TransportToolItem {
  /** The DOM id the control shipped with; these are a public contract. */
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly onSelect?: () => void;
}

export interface TransportToolGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly TransportToolItem[];
}

interface TransportToolSpec {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly handler: TransportToolHandlerKey;
}

interface TransportToolGroupSpec {
  readonly id: string;
  readonly label: string;
  readonly items: readonly TransportToolSpec[];
}

/**
 * The single source of truth for the overflow tools. Order is deliberate: sound
 * design first, then time/audio editing, then mixing, then controller/session.
 */
export const TRANSPORT_TOOL_GROUPS: readonly TransportToolGroupSpec[] = [
  {
    id: 'sound',
    label: 'Sound & instruments',
    items: [
      {
        id: 'fl-sampler-modal-btn',
        label: 'Sample library',
        title: 'Import audio samples and slice them',
        icon: Disc3,
        handler: 'samples',
      },
      {
        id: 'fl-wavetable-btn',
        label: 'Wavetable synth',
        title: '3D wavetable morphing synthesizer',
        icon: AudioWaveform,
        handler: 'wavetable',
      },
      {
        id: 'fl-multizone-btn',
        label: 'Multi-zone keymap',
        title: 'Keyboard split and velocity keymapping',
        icon: Grid3x3,
        handler: 'keymap',
      },
      {
        id: 'fl-vocal-tuner-btn',
        label: 'Vocal tuner',
        title: 'Real-time auto-pitch and pitch correction',
        icon: MicVocal,
        handler: 'vocalTuner',
      },
    ],
  },
  {
    id: 'time',
    label: 'Time & audio',
    items: [
      {
        id: 'fl-gross-beat-btn',
        label: 'Time FX',
        title: 'Half-time, tape stop and turntable time effects',
        icon: Waves,
        handler: 'timeFx',
      },
      {
        id: 'fl-warp-processor-btn',
        label: 'Warp modes',
        title: 'Advanced time-stretch and transient warp modes',
        icon: Timer,
        handler: 'warp',
      },
      {
        id: 'fl-slicer-btn',
        label: 'Transient slicer',
        title: 'Slice and chop audio at its transients',
        icon: Scissors,
        handler: 'slicer',
      },
      {
        id: 'fl-take-comp-btn',
        label: 'Take comping',
        title: 'Stacked loop recording and swipe comping',
        icon: Layers,
        handler: 'comping',
      },
    ],
  },
  {
    id: 'mixing',
    label: 'Mixing & master',
    items: [
      {
        id: 'fl-master-eq-btn',
        label: '7-band EQ',
        title: 'Open the master parametric EQ',
        icon: Activity,
        handler: 'eq',
      },
      {
        id: 'fl-mastering-suite-btn',
        label: 'Mastering suite',
        title: 'LUFS metering, multiband processing and limiter',
        icon: Gauge,
        handler: 'mastering',
      },
      {
        id: 'fl-sidechain-matrix-btn',
        label: 'Sidechain matrix',
        title: 'Dynamic sidechain ducking and modulation routing',
        icon: GitBranch,
        handler: 'sidechain',
      },
      {
        id: 'fl-master-macros-btn',
        label: 'Master macros',
        title: 'Multi-target performance macro knobs',
        icon: Blocks,
        handler: 'macros',
      },
    ],
  },
  {
    id: 'session',
    label: 'Controller & session',
    items: [
      {
        id: 'fl-midi-learn-btn',
        label: 'MIDI learn',
        title: 'Map hardware controller CCs to DAW parameters',
        icon: Sliders,
        handler: 'midiLearn',
      },
      {
        id: 'fl-project-zip-btn',
        label: 'Project bundle (.zip)',
        title: 'Export or import a portable project bundle',
        icon: FolderArchive,
        handler: 'projectBundle',
      },
      {
        id: 'fl-desktop-app-btn',
        label: 'Desktop app',
        title: 'Open the Windows desktop application info',
        icon: Monitor,
        handler: 'desktopApp',
      },
      {
        id: 'fl-collab-btn',
        label: 'Studio notes',
        title: 'Local project annotations and studio notes',
        icon: Users,
        handler: 'collab',
      },
    ],
  },
];

/** Every secondary tool id, in menu order. */
export const TRANSPORT_TOOL_IDS: readonly string[] = TRANSPORT_TOOL_GROUPS.flatMap(group =>
  group.items.map(item => item.id)
);

/** Binds the shipped handlers onto the tool spec. */
export const createTransportToolGroups = (
  handlers: TransportToolHandlers
): readonly TransportToolGroup[] =>
  TRANSPORT_TOOL_GROUPS.map(group => ({
    id: group.id,
    label: group.label,
    items: group.items.map(item => ({
      id: item.id,
      label: item.label,
      title: item.title,
      icon: item.icon,
      onSelect: handlers[item.handler],
    })),
  }));

/** A tool is reachable when the transport was given a handler for it. */
export const isTransportToolEnabled = (item: TransportToolItem | undefined): boolean =>
  Boolean(item?.onSelect);

const flattenTools = (groups: readonly TransportToolGroup[]): readonly TransportToolItem[] =>
  groups.flatMap(group => group.items);

/** The ids a keyboard user can move between, in visual order. */
export const getEnabledToolIds = (groups: readonly TransportToolGroup[]): readonly string[] =>
  flattenTools(groups)
    .filter(isTransportToolEnabled)
    .map(item => item.id);

/**
 * Roving-focus arithmetic for the tool menu. Returns the index within
 * `length` enabled items; `-1` means "nothing to focus" (empty menu).
 */
export const getNextToolItemIndex = (currentIndex: number, length: number, key: string): number => {
  if (length <= 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return currentIndex < 0 ? 0 : (currentIndex + 1) % length;
    case 'ArrowUp':
      return currentIndex < 0 ? length - 1 : (currentIndex - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return currentIndex;
  }
};

/**
 * The tool id that should receive focus after a key press, or null when the key
 * is not a menu navigation key (Tab leaves the menu to the page on purpose).
 */
export const getToolFocusTarget = (
  groups: readonly TransportToolGroup[],
  currentItemId: string | null,
  key: string
): string | null => {
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return null;
  const enabledIds = getEnabledToolIds(groups);
  if (enabledIds.length === 0) return null;
  const currentIndex = currentItemId === null ? -1 : enabledIds.indexOf(currentItemId);
  const nextIndex = getNextToolItemIndex(currentIndex, enabledIds.length, key);
  return nextIndex < 0 ? null : enabledIds[nextIndex];
};

/**
 * Click-outside and Escape handling for the tool menu. Thin wrapper over the
 * audited 1B helper so there is one implementation of "Escape must not reach the
 * editors" in the codebase.
 */
export const createTransportToolsMenuDismissHandlers = (
  getTrigger: () => { contains: (node: never) => boolean } | null,
  getPanel: () => { contains: (node: never) => boolean } | null,
  dismiss: () => void
) =>
  createApplicationMenuDismissHandlers(() => {
    const trigger = getTrigger();
    const panel = getPanel();
    if (!trigger && !panel) return null;
    return {
      contains: (node: never) => Boolean(trigger?.contains(node) || panel?.contains(node)),
    };
  }, dismiss);

/**
 * Wraps the menu groups so activating a tool dismisses the menu first and then
 * runs the tool. Tools without a handler stay `undefined`, so they still render
 * as disabled instead of dismissing the menu.
 */
export const withTransportToolDismiss = (
  groups: readonly TransportToolGroup[],
  dismiss: () => void
): readonly TransportToolGroup[] =>
  groups.map(group => ({
    ...group,
    items: group.items.map(item =>
      item.onSelect
        ? {
            ...item,
            onSelect: () => {
              dismiss();
              item.onSelect?.();
            },
          }
        : item
    ),
  }));

export interface TransportToolsMenuViewProps {
  groups: readonly TransportToolGroup[];
  onItemKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>, itemId: string) => void;
  /** Called with the index among enabled tools, so roving focus skips disabled rows. */
  registerItemRef?: (index: number, element: HTMLButtonElement | null) => void;
  panelRef?: React.Ref<HTMLDivElement>;
  style?: React.CSSProperties;
}

/**
 * Pure presentation of the overflow menu, so the shell tests can assert the
 * rendered tool set without a browser.
 */
export const TransportToolsMenuView: React.FC<TransportToolsMenuViewProps> = ({
  groups,
  onItemKeyDown,
  registerItemRef,
  panelRef,
  style,
}) => {
  let enabledIndex = -1;

  return (
    <div
      id={TRANSPORT_TOOLS_MENU_ID}
      ref={panelRef}
      role="menu"
      aria-labelledby={TRANSPORT_TOOLS_TRIGGER_ID}
      className="apex-tool-menu"
      style={style}
    >
      <div className="apex-tool-menu-header">All tools</div>
      {groups.map(group => (
        <div key={group.id} role="group" aria-label={group.label} className="apex-tool-menu-group">
          <div className="apex-tool-menu-group-label" aria-hidden="true">
            {group.label}
          </div>
          {group.items.map(item => {
            const enabled = isTransportToolEnabled(item);
            const index = enabled ? (enabledIndex += 1) : -1;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                id={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={!enabled}
                aria-disabled={enabled ? undefined : true}
                title={item.title}
                className="apex-tool-menu-item"
                ref={element => registerItemRef?.(index, element)}
                onClick={() => item.onSelect?.()}
                onKeyDown={event => onItemKeyDown?.(event, item.id)}
              >
                <Icon className="apex-tool-menu-icon" aria-hidden="true" />
                <span className="apex-tool-menu-label">{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export interface TransportToolsMenuProps {
  groups: readonly TransportToolGroup[];
}

/**
 * Stateful trigger + popover.
 *
 * The panel is portalled to `document.body`: the transport row is pinned to
 * `overflow-hidden` by the shell layout tests, so an absolutely positioned panel
 * inside the header would be clipped. Position is measured from the trigger on
 * open and on viewport changes.
 */
export const TransportToolsMenu: React.FC<TransportToolsMenuProps> = ({ groups }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusFirstOnOpen = useRef(false);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || typeof window === 'undefined') return;
    const top = Math.round(rect.bottom + 6);
    setPosition({
      top,
      right: Math.round(Math.max(8, window.innerWidth - rect.right)),
      maxHeight: Math.max(160, Math.round(window.innerHeight - top - 12)),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
    const onViewportChange = () => updatePosition();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, updatePosition]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const { handlePointerDown, handleKeyDown } = createTransportToolsMenuDismissHandlers(
      () => triggerRef.current as unknown as { contains: (node: never) => boolean } | null,
      () => panelRef.current as unknown as { contains: (node: never) => boolean } | null,
      close
    );
    const onPointerDown = (event: PointerEvent) => handlePointerDown({ target: event.target });
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || !focusFirstOnOpen.current) return;
    focusFirstOnOpen.current = false;
    itemRefs.current[0]?.focus();
  }, [open]);

  const openWithFocus = (focusFirst: boolean) => {
    focusFirstOnOpen.current = focusFirst;
    setOpen(true);
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) openWithFocus(true);
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
  };

  const handleItemKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, itemId: string) => {
    if (event.key === 'Tab') {
      // Tab is a request to leave the menu; let the browser move focus on.
      setOpen(false);
      return;
    }
    const target = getToolFocusTarget(groups, itemId, event.key);
    if (target === null) return;
    event.preventDefault();
    const enabledIds = getEnabledToolIds(groups);
    itemRefs.current[enabledIds.indexOf(target)]?.focus();
  };

  const dismissableGroups = useMemo(() => withTransportToolDismiss(groups, close), [groups, close]);

  const panel =
    open && position && typeof document !== 'undefined'
      ? createPortal(
          <TransportToolsMenuView
            groups={dismissableGroups}
            panelRef={panelRef}
            registerItemRef={(index, element) => {
              if (index < 0) return;
              itemRefs.current[index] = element;
            }}
            onItemKeyDown={handleItemKeyDown}
            style={{
              position: 'fixed',
              top: position.top,
              right: position.right,
              maxHeight: position.maxHeight,
            }}
          />,
          document.body
        )
      : null;

  return (
    <div className="apex-tool-cluster-item">
      <button
        id={TRANSPORT_TOOLS_TRIGGER_ID}
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? TRANSPORT_TOOLS_MENU_ID : undefined}
        aria-label="Tools"
        title={`All tools (${TRANSPORT_TOOL_IDS.length})`}
        className="apex-tool-chip apex-tools-trigger"
        onClick={() => (open ? close() : openWithFocus(true))}
        onKeyDown={handleTriggerKeyDown}
      >
        <Wrench className="apex-chip-icon" aria-hidden="true" />
        <span className="apex-chip-label">Tools</span>
        <ChevronDown className="apex-chip-caret" aria-hidden="true" />
      </button>
      {panel}
    </div>
  );
};

export default TransportToolsMenu;
