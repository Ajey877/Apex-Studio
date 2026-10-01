import React from 'react';
import { ProjectMetadata, ViewMode } from '../types/daw';
import { WORKSPACE_TABS } from './TransportBar';

/**
 * UI Milestone 1C — Step 3: the status bar.
 *
 * The status bar is *informational only*: zero buttons, zero actions. Every
 * action the old footer pretended to offer (Hotkeys, Export) already has its
 * real entry point in the transport and the application menu, so the footer
 * duplicates nothing.
 *
 * Truthfulness contract:
 *   - no fabricated telemetry (the old "DSP CPU" readout is gone),
 *   - no fake "STORAGE: LOCAL" chip — save state comes from the existing
 *     `saveError` string, so "Saved" is only shown after a real save
 *     succeeded and "Save failed" carries the real error message,
 *   - the project name is the real `meta.name`,
 *   - the active view name comes from the existing workspace tab model
 *     (`WORKSPACE_TABS`), never a second copy of the view list,
 *   - the counts are read straight from the project state in App.
 */

export interface StatusBarProps {
  meta: ProjectMetadata;
  currentView: ViewMode;
  saveError?: string | null;
  channelCount: number;
  clipCount: number;
}

/**
 * The single path from the shell's view state to a display name, backed by the
 * workspace tab model so the ribbon and the status bar can never disagree.
 */
export const activeWorkspaceViewLabel = (view: ViewMode): string => {
  const tab = WORKSPACE_TABS.find(candidate => candidate.view === view);
  return tab ? tab.label : view;
};

export const StatusBar: React.FC<StatusBarProps> = ({
  meta,
  currentView,
  saveError,
  channelCount,
  clipCount,
}) => {
  return (
    <footer
      id="studio-status-bar"
      className="apex-statusbar h-6 shrink-0 select-none"
      aria-label="Project status"
    >
      <div className="apex-statusbar-group">
        <span className="apex-status-item apex-status-item--project" title={meta.name}>
          <span className="apex-status-label">Project</span>
          <span className="apex-status-value">{meta.name}</span>
        </span>
        <span
          className="apex-status-item apex-status-item--save"
          data-state={saveError ? 'error' : 'ok'}
          title={saveError ?? 'All changes saved'}
        >
          <span className="apex-status-label">Save</span>
          <span className="apex-status-value">{saveError ? 'Save failed' : 'Saved'}</span>
        </span>
      </div>

      <div className="apex-statusbar-group">
        <span className="apex-status-item">
          <span className="apex-status-label">View</span>
          <span className="apex-status-value">{activeWorkspaceViewLabel(currentView)}</span>
        </span>
        <span className="apex-status-item">
          <span className="apex-status-label">Channels</span>
          <span className="apex-status-value">{channelCount}</span>
        </span>
        <span className="apex-status-item">
          <span className="apex-status-label">Clips</span>
          <span className="apex-status-value">{clipCount}</span>
        </span>
      </div>
    </footer>
  );
};

export default StatusBar;
