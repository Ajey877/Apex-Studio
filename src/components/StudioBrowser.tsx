import React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Disc,
  Folder,
  Play,
  Plus,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { InstrumentType } from '../types/daw';
import { PRESET_PROJECTS } from '../audio/presets';

/**
 * UI Milestone 1C — Step 3: the studio browser sidebar.
 *
 * The browser is the shell's asset navigation surface. It is deliberately
 * presentational: every action is delegated to the existing App handlers
 * (`handleAddChannel`, `handleAuditionSample`, `handleLoadProjectState`,
 * project hub), so this component adds no project, persistence or audio
 * behaviour of its own.
 *
 * Accessibility contract:
 *   - every row and folder header is a native `<button>`, so Enter/Space and
 *     the Tab order work without a script,
 *   - folder headers expose `aria-expanded` + `aria-controls`,
 *   - the drum-sample audition state is exposed with `aria-pressed`,
 *   - every interactive element gets the shell focus-visible ring from
 *     `index.css`.
 *
 * Truthfulness contract:
 *   - the preview surface reports the sample that is actually auditioning and
 *     nothing else — no fabricated waveform, no fabricated telemetry.
 */

export interface StudioBrowserInstrument {
  readonly name: string;
  readonly type: InstrumentType;
  readonly color: string;
}

export interface StudioBrowserDrumSample {
  readonly name: string;
  readonly pitch: number;
}

export type StudioBrowserPresetProject = (typeof PRESET_PROJECTS)[number];

export interface StudioBrowserFolder {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * The browser's contents, declared once so the list the user sees and the list
 * the shell tests assert on can never drift apart. These are the exact
 * instruments, drum samples and demo projects the inline browser shipped with;
 * the row handlers in App keep their original arguments.
 */
export const STUDIO_BROWSER_INSTRUMENTS: readonly StudioBrowserInstrument[] = [
  { name: 'Grand Concert Piano', type: 'grand_piano', color: '#e0e0e0' },
  { name: 'Vintage Rhodes MK1', type: 'rhodes_epiano', color: '#e67e22' },
  { name: 'Hammond B3 Organ', type: 'hammond_organ', color: '#d35400' },
  { name: 'Orchestral Strings', type: 'strings_ensemble', color: '#9b59b6' },
  { name: 'Pizzicato Strings', type: 'pizzicato_strings', color: '#8e44ad' },
  { name: 'Nylon Pluck Guitar', type: 'nylon_guitar', color: '#27ae60' },
  { name: 'Cinematic Horns/Brass', type: 'cinematic_brass', color: '#f39c12' },
  { name: '808 Tuned Sub Bass', type: 'sub_808', color: '#ff5722' },
  { name: 'TB-303 Acid Bassline', type: 'acid_303', color: '#2ecc71' },
  { name: 'Reese Heavy Bass', type: 'reese_bass', color: '#c0392b' },
  { name: 'JP-8000 Supersaw', type: 'supersaw_lead', color: '#00d2d3' },
  { name: 'Atmospheric Pad', type: 'ambient_pad', color: '#54a0ff' },
  { name: 'Vocal Choir Formant', type: 'vox_choir', color: '#ff9ff3' },
  { name: 'Wooden Marimba/Bell', type: 'marimba_bell', color: '#1dd1a1' },
  { name: '8-Bit Retro Chiptune', type: 'chiptune_8bit', color: '#feca57' },
  { name: 'MiniSynth Subtractive', type: 'minisynth', color: '#ff6e00' },
  { name: 'Toxic FM Synthesizer', type: 'fmsynth', color: '#00bcd4' },
  { name: 'DirectWave Sampler', type: 'sampler', color: '#4caf50' },
  { name: '808 Drum Machine', type: 'drumpad', color: '#ff5722' },
];

export const STUDIO_BROWSER_DRUM_SAMPLES: readonly StudioBrowserDrumSample[] = [
  { name: '808_Sub_Punch.wav', pitch: 36 },
  { name: 'Snare_Trap_Hard.wav', pitch: 38 },
  { name: 'HiHat_Closed_Tight.wav', pitch: 42 },
  { name: 'Clap_Studio_Dry.wav', pitch: 39 },
  { name: 'Perc_Rimshot_Wood.wav', pitch: 37 },
];

/**
 * The three browser folders, in DOM order. The ids are the same keys App uses
 * in its `expandedFolders` state, so the fold state survives the redesign.
 */
export const STUDIO_BROWSER_FOLDERS: readonly StudioBrowserFolder[] = [
  { id: 'instruments', label: 'Synths & Generators', icon: Cpu },
  { id: 'drums', label: 'Drum Samples (808 / MPC)', icon: Disc },
  { id: 'presets', label: 'Studio Demos', icon: Folder },
];

/**
 * The one search filter for every folder. A trimmed, case-insensitive name
 * match, applied to the declared lists so the browser cannot advertise a row
 * the user cannot reach.
 */
export const filterStudioBrowserRows = <T extends { readonly name: string }>(
  items: readonly T[],
  search: string
): readonly T[] => {
  const query = search.trim().toLowerCase();
  if (query === '') return items;
  return items.filter(item => item.name.toLowerCase().includes(query));
};

export interface StudioBrowserProps {
  search: string;
  onSearchChange: (value: string) => void;
  expandedFolders: Record<string, boolean>;
  onToggleFolder: (folderId: string) => void;
  /** The name of the sample App is auditioning right now, if any. */
  previewingAudio: string | null;
  /** "+ New": opens the project hub, exactly like the inline browser did. */
  onOpenProjectManager: () => void;
  /** Loads an instrument into the channel rack through the existing handler. */
  onAddInstrument: (instrument: StudioBrowserInstrument) => void;
  /** Auditions a drum sample through the existing handler (name, pitch). */
  onAuditionSample: (name: string, pitch: number) => void;
  /** Loads a demo project through the existing replacement path. */
  onLoadPresetProject: (preset: StudioBrowserPresetProject) => void;
}

interface FolderButtonProps {
  folder: StudioBrowserFolder;
  expanded: boolean;
  onToggleFolder: (folderId: string) => void;
}

const FolderButton: React.FC<FolderButtonProps> = ({ folder, expanded, onToggleFolder }) => {
  const Icon = folder.icon;
  return (
    <button
      type="button"
      id={`browser-folder-toggle-${folder.id}`}
      aria-expanded={expanded}
      aria-controls={`browser-folder-items-${folder.id}`}
      onClick={() => onToggleFolder(folder.id)}
      className="apex-browser-folder-btn"
    >
      <Icon className="apex-browser-folder-icon" aria-hidden="true" />
      <span className="apex-browser-folder-label">{folder.label}</span>
      {expanded ? (
        <ChevronDown className="apex-browser-caret" aria-hidden="true" />
      ) : (
        <ChevronRight className="apex-browser-caret" aria-hidden="true" />
      )}
    </button>
  );
};

export const StudioBrowser: React.FC<StudioBrowserProps> = ({
  search,
  onSearchChange,
  expandedFolders,
  onToggleFolder,
  previewingAudio,
  onOpenProjectManager,
  onAddInstrument,
  onAuditionSample,
  onLoadPresetProject,
}) => {
  const instruments = filterStudioBrowserRows(STUDIO_BROWSER_INSTRUMENTS, search);
  const drumSamples = filterStudioBrowserRows(STUDIO_BROWSER_DRUM_SAMPLES, search);
  const presetProjects = filterStudioBrowserRows(PRESET_PROJECTS, search);

  return (
    <aside id="studio-browser" className="apex-sidebar w-56 md:w-64 flex flex-col shrink-0 border-r" aria-label="Studio Browser">
      {/* Header surface: identity plus the single "+ New" entry point. */}
      <header className="apex-browser-header">
        <span className="apex-browser-title">Studio Browser</span>
        <button
          type="button"
          id="browser-new-project-btn"
          onClick={onOpenProjectManager}
          aria-label="New project — open the project hub"
          title="Open the project hub"
          className="apex-browser-action"
        >
          <Plus className="apex-browser-action-icon" aria-hidden="true" />
          <span>New</span>
        </button>
      </header>

      {/* Search surface: one labelled field that filters every folder below. */}
      <div className="apex-browser-search">
        <Search className="apex-browser-search-icon" aria-hidden="true" />
        <input
          id="studio-browser-search"
          type="text"
          placeholder="Search instruments, samples & demos"
          value={search}
          onChange={event => onSearchChange(event.target.value)}
          aria-label="Search instruments, samples and demo projects"
          className="apex-browser-search-input"
        />
      </div>

      {/* Body surface: the three collapsible folders. */}
      <div id="studio-browser-body" className="apex-browser-body custom-scrollbar">
        <section className="apex-browser-folder">
          <FolderButton folder={STUDIO_BROWSER_FOLDERS[0]} expanded={Boolean(expandedFolders['instruments'])} onToggleFolder={onToggleFolder} />
          {Boolean(expandedFolders['instruments']) && (
            <div id="browser-folder-items-instruments" role="group" aria-labelledby="browser-folder-toggle-instruments" className="apex-browser-folder-items">
              {instruments.length === 0 && <p className="apex-browser-empty">No matches</p>}
              {instruments.map(instrument => (
                <button
                  key={instrument.name}
                  type="button"
                  onClick={() => onAddInstrument(instrument)}
                  aria-label={`Load ${instrument.name} into the channel rack`}
                  className="apex-browser-row"
                >
                  <span className="apex-browser-row-label">{instrument.name}</span>
                  <span className="apex-browser-row-hint apex-browser-row-hint--reveal" aria-hidden="true">+ Load</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="apex-browser-folder">
          <FolderButton folder={STUDIO_BROWSER_FOLDERS[1]} expanded={Boolean(expandedFolders['drums'])} onToggleFolder={onToggleFolder} />
          {Boolean(expandedFolders['drums']) && (
            <div id="browser-folder-items-drums" role="group" aria-labelledby="browser-folder-toggle-drums" className="apex-browser-folder-items">
              {drumSamples.length === 0 && <p className="apex-browser-empty">No matches</p>}
              {drumSamples.map(sample => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => onAuditionSample(sample.name, sample.pitch)}
                  aria-pressed={previewingAudio === sample.name}
                  aria-label={`Audition ${sample.name}`}
                  className="apex-browser-row apex-browser-row--audition"
                >
                  <span className="apex-browser-row-label">{sample.name}</span>
                  <Play className="apex-browser-row-icon" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="apex-browser-folder">
          <FolderButton folder={STUDIO_BROWSER_FOLDERS[2]} expanded={Boolean(expandedFolders['presets'])} onToggleFolder={onToggleFolder} />
          {Boolean(expandedFolders['presets']) && (
            <div id="browser-folder-items-presets" role="group" aria-labelledby="browser-folder-toggle-presets" className="apex-browser-folder-items">
              {presetProjects.length === 0 && <p className="apex-browser-empty">No matches</p>}
              {presetProjects.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onLoadPresetProject(preset)}
                  aria-label={`Load demo project ${preset.name} at ${preset.bpm} BPM`}
                  className="apex-browser-row"
                >
                  <span className="apex-browser-row-label">{preset.name}</span>
                  <span className="apex-browser-row-hint">{preset.bpm} BPM</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Preview surface: the honest audition state — the sample that is
          actually sounding, or the idle hint. No waveform, no telemetry. */}
      <footer id="studio-browser-preview" className="apex-browser-preview">
        <div className="apex-browser-preview-row">
          <span className="apex-browser-preview-label">Preview</span>
          <span className="apex-browser-preview-state" data-active={previewingAudio !== null}>
            {previewingAudio ? 'Auditioning' : 'Ready'}
          </span>
        </div>
        <div className="apex-browser-preview-sample">
          {previewingAudio ?? 'Select a drum sample to audition it'}
        </div>
      </footer>
    </aside>
  );
};

export default StudioBrowser;
