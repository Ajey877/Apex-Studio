import React, { useState, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Upload, 
  Music, 
  Volume2, 
  Scissors, 
  RotateCw, 
  Play, 
  Check, 
  X, 
  Sliders, 
  FolderOpen,
  Plus,
  Trash2,
  AlertTriangle
} from 'lucide-react';
import { Channel, CustomSampleData } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { importSampleFile } from '../audio/sampleImport';
import {
  MISSING_AUDIO_SAMPLE_BADGE_LABEL,
  describeMissingAudioSample,
  isSampleAudioUnavailable
} from '../state/audioAssetAvailability';

interface SampleManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  selectedChannel: Channel;
  sampleLibrary: CustomSampleData[];
  onSampleImported: (sample: CustomSampleData) => void;
  onAssignSampleToChannel: (channelId: string, sample: CustomSampleData) => void;
  onCreateChannelFromSample: (sample: CustomSampleData) => void;
}



export const SampleManagerModal: React.FC<SampleManagerModalProps> = ({
  isOpen,
  onClose,
  channels,
  selectedChannel,
  sampleLibrary,
  onSampleImported,
  onAssignSampleToChannel,
  onCreateChannelFromSample
}) => {
  const [currentSample, setCurrentSample] = useState<CustomSampleData | null>(selectedChannel?.customSample || null);
  const [targetChannelId, setTargetChannelId] = useState<string>(selectedChannel?.id || channels[0]?.id || '');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [trimStart, setTrimStart] = useState<number>(0);
  const [trimEnd, setTrimEnd] = useState<number>(1.0);
  const [rootPitch, setRootPitch] = useState<number>(60);
  const [reverseSample, setReverseSample] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const handleFileUpload = async (file: File) => {
    try {
      setIsLoading(true);
      setErrorMessage(null);
      // Decodes into the engine and persists the original file before exposing it
      // as a project-assignable sample.
      const result = await importSampleFile(file, { engine: audioEngine });
      if (result.persisted === false) {
        setCurrentSample(null);
        const message = result.error instanceof Error ? result.error.message : 'Audio sample could not be saved';
        setErrorMessage(`Sample import failed: ${message}`);
        return;
      }

      setCurrentSample(result.sample);
      onSampleImported(result.sample);
      setTrimStart(0);
      setTrimEnd(1.0);
      setRootPitch(60);
    } catch (err) {
      console.error('Error decoding audio sample:', err);
      setCurrentSample(null);
      setErrorMessage(`Sample import failed: ${err instanceof Error ? err.message : 'Unable to decode audio'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  // Phase 8C (P1-11): the selected channel's sample exists in the project but its
  // persisted audio could not be restored. It must not be presented as healthy.
  const isCurrentSampleUnavailable = isSampleAudioUnavailable(currentSample);
  const unavailableSampleDescription = currentSample && isCurrentSampleUnavailable
    ? describeMissingAudioSample(currentSample, selectedChannel?.name)
    : undefined;

  const handleAudition = () => {
    if (!currentSample || isCurrentSampleUnavailable) return;
    const dummyNote = { id: 'audition', pitch: rootPitch, start: 0, duration: 1.5, velocity: 0.9 };
    const tempChannel: Channel = {
      ...selectedChannel,
      customSample: {
        ...currentSample,
        trimStart,
        trimEnd,
        rootPitch,
        reverse: reverseSample
      }
    };
    audioEngine.playNote(tempChannel, dummyNote);
  };

  const handleAssign = () => {
    if (!currentSample || isCurrentSampleUnavailable) return;
    const finalSample: CustomSampleData = {
      ...currentSample,
      trimStart,
      trimEnd,
      rootPitch,
      reverse: reverseSample
    };
    onAssignSampleToChannel(targetChannelId, finalSample);
    onClose();
  };

  const handleCreateNew = () => {
    if (!currentSample || isCurrentSampleUnavailable) return;
    const finalSample: CustomSampleData = {
      ...currentSample,
      trimStart,
      trimEnd,
      rootPitch,
      reverse: reverseSample
    };
    onCreateChannelFromSample(finalSample);
    onClose();
  };

  return (
    <ModalFrame labelledBy="sample-manager-modal-title" onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-md animate-fade-in select-none">
      <div className="bg-[var(--apex-panel)] border border-[var(--apex-state-selected-border)] rounded-xl w-full max-w-2xl flex flex-col shadow-2xl overflow-hidden text-[var(--apex-text-2)]">
        {/* Header */}
        <div className="bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--apex-accent)] flex items-center justify-center text-[var(--apex-state-playing-fg)] font-black">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 id="sample-manager-modal-title" className="text-sm font-bold text-[var(--apex-text)] uppercase">APEX AUDIO SAMPLE LOADER</h2>
              <p className="text-[11px] text-[var(--apex-text-muted)]">Import custom WAV / MP3 one-shots, slice waveforms & map across piano roll</p>
            </div>
          </div>

          <button onClick={onClose} aria-label="Close sample manager" className="p-1 text-[var(--apex-text-muted)] hover:text-[var(--apex-text)] rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto custom-scrollbar">
          {/* Dropzone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-[var(--apex-border)] hover:border-[var(--apex-accent-strong)] bg-[var(--apex-canvas)] hover:bg-[var(--apex-state-hover)] p-6 rounded-xl text-center cursor-pointer transition flex flex-col items-center justify-center gap-2"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.ogg,.flac,.aac"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleFileUpload(e.target.files[0]);
                }
              }}
            />
            <div className="w-10 h-10 rounded-full bg-[var(--apex-surface-2)] flex items-center justify-center text-[var(--apex-accent)]">
              <Upload className="w-5 h-5" />
            </div>
            <div>
              <span className="text-xs font-bold text-[var(--apex-text)]">Drag & drop your audio sample here</span>
              <p className="text-[11px] text-[var(--apex-text-3)]">Supports WAV, MP3, AIFF, FLAC, OGG one-shots & loops</p>
            </div>
          </div>

          {errorMessage && (
            <div id="sample-manager-error" role="alert" className="p-2.5 bg-[color-mix(in_srgb,var(--apex-danger)_12%,var(--apex-panel))] border border-[color-mix(in_srgb,var(--apex-danger)_55%,transparent)] rounded-lg text-[11px] text-[var(--apex-danger)] select-text">
              {errorMessage}
            </div>
          )}

          {/* Persistent Sample Library */}
          <div className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--apex-text)]">
                <Music className="w-3.5 h-3.5 text-[var(--apex-accent)]" />
                SAMPLE LIBRARY
              </div>
              <span className="text-[10px] text-[var(--apex-text-3)]">{sampleLibrary.length} sample{sampleLibrary.length === 1 ? '' : 's'}</span>
            </div>
            {sampleLibrary.length === 0 ? (
              <p className="text-[11px] text-[var(--apex-text-3)]">Imported samples will stay available here even before they are assigned to a channel.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-36 overflow-y-auto custom-scrollbar">
                {sampleLibrary.map(sample => (
                  <button key={sample.id} type="button" onClick={() => {
                    setCurrentSample(sample);
                    setTrimStart(sample.trimStart ?? 0);
                    setTrimEnd(sample.trimEnd ?? 1);
                    setRootPitch(sample.rootPitch ?? 60);
                    setReverseSample(Boolean(sample.reverse));
                  }} className={`text-left p-2 rounded-lg border transition ${currentSample?.id === sample.id ? 'border-[var(--apex-accent)] bg-[var(--apex-state-selected)]' : 'border-[var(--apex-border)] bg-[var(--apex-panel)] hover:border-[var(--apex-grid-line-strong)]'}`}>
                    <div className="text-[11px] font-bold text-[var(--apex-text)] truncate">{sample.name}</div>
                    <div className="text-[9px] text-[var(--apex-text-3)] font-mono">{sample.duration.toFixed(2)}s · {sample.sampleRate}Hz</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sample Waveform Editor */}
          {currentSample ? (
            <div
              id="sample-manager-sample-panel"
              data-audio-unavailable={isCurrentSampleUnavailable ? 'true' : undefined}
              className={`bg-[var(--apex-panel)] border rounded-xl p-4 space-y-3 ${
                isCurrentSampleUnavailable ? 'border-[color-mix(in_srgb,var(--apex-danger)_55%,transparent)]' : 'border-[var(--apex-border)]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className={`text-xs font-bold ${isCurrentSampleUnavailable ? 'text-[var(--apex-danger)]' : 'text-[var(--apex-text)]'}`}>{currentSample.name}</span>
                  <span className="text-[10px] font-mono text-[var(--apex-text-muted)] ml-2">
                    {currentSample.duration.toFixed(2)}s | {currentSample.sampleRate}Hz
                  </span>
                  {isCurrentSampleUnavailable && (
                    <span
                      id="sample-manager-missing-badge"
                      data-audio-unavailable="true"
                      className="ml-2 inline-flex items-center gap-0.5 px-1 py-[1px] rounded bg-[var(--apex-danger)] text-[var(--apex-state-recording-fg)] text-[8px] font-bold uppercase tracking-wide align-middle"
                    >
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {MISSING_AUDIO_SAMPLE_BADGE_LABEL}
                    </span>
                  )}
                </div>

                <button
                  onClick={handleAudition}
                  disabled={isCurrentSampleUnavailable}
                  title={unavailableSampleDescription}
                  className={`flex items-center gap-1.5 px-3 py-1 font-bold text-xs rounded transition shadow ${
                    isCurrentSampleUnavailable
                      ? 'bg-[var(--apex-surface-3)] text-[var(--apex-text-3)] cursor-not-allowed'
                      : 'bg-[var(--apex-success)] hover:brightness-110 text-[var(--apex-state-playing-fg)]'
                  }`}
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Audition Sample</span>
                </button>
              </div>

              {isCurrentSampleUnavailable && (
                <div
                  id="sample-manager-missing-audio"
                  role="alert"
                  data-audio-unavailable="true"
                  className="flex items-start gap-2 p-2.5 bg-[color-mix(in_srgb,var(--apex-danger)_12%,var(--apex-panel))] border border-[color-mix(in_srgb,var(--apex-danger)_55%,transparent)] rounded-lg text-[11px] text-[var(--apex-danger)] select-text"
                >
                  <AlertTriangle className="w-4 h-4 text-[var(--apex-danger)] shrink-0 mt-0.5" />
                  <span>{unavailableSampleDescription}</span>
                </div>
              )}

              {/* Waveform Visualization Canvas */}
              <div className={`relative h-20 bg-[var(--apex-canvas)] border rounded-lg p-2 flex items-center gap-0.5 overflow-hidden ${
                isCurrentSampleUnavailable ? 'border-[color-mix(in_srgb,var(--apex-danger)_55%,transparent)]' : 'border-[var(--apex-border)]'
              }`}>
                {isCurrentSampleUnavailable ? (
                  <>
                    <div className="w-full border-t border-dashed border-[color-mix(in_srgb,var(--apex-danger)_80%,transparent)]" />
                    <span className="absolute left-2 text-[10px] font-bold uppercase tracking-wide text-[var(--apex-danger)]">
                      {MISSING_AUDIO_SAMPLE_BADGE_LABEL} — waveform unavailable
                    </span>
                  </>
                ) : currentSample.waveformPeaks.map((peak, idx) => {
                  const normIdx = idx / currentSample.waveformPeaks.length;
                  const isInsideTrim = normIdx >= trimStart && normIdx <= trimEnd;
                  return (
                    <div
                      key={idx}
                      className={`flex-1 rounded-xs transition-all ${
                        isInsideTrim ? 'bg-[var(--apex-accent)]' : 'bg-[var(--apex-surface-3)]'
                      }`}
                      style={{ height: `${Math.max(10, peak * 90)}%` }}
                    />
                  );
                })}

                {/* Trim Markers (hidden when the underlying audio is gone) */}
                {!isCurrentSampleUnavailable && (
                  <>
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-[var(--apex-success)] shadow-[0_0_8px_var(--apex-success)]"
                      style={{ left: `${trimStart * 100}%` }}
                    />
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-[var(--apex-danger)] shadow-[0_0_8px_var(--apex-danger)]"
                      style={{ left: `${trimEnd * 100}%` }}
                    />
                  </>
                )}
              </div>

              {/* Slicing & Root Note Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-muted)] mb-1">
                    <span>Start Trim</span>
                    <span className="font-mono text-[var(--apex-success)]">{(trimStart * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range" min="0" max="0.9" step="0.01"
                    value={trimStart}
                    onChange={(e) => setTrimStart(Number(e.target.value))}
                    className="w-full accent-[var(--apex-success)]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-muted)] mb-1">
                    <span>End Trim</span>
                    <span className="font-mono text-[var(--apex-danger)]">{(trimEnd * 100).toFixed(0)}%</span>
                  </div>
                  <input
                    type="range" min="0.1" max="1.0" step="0.01"
                    value={trimEnd}
                    onChange={(e) => setTrimEnd(Number(e.target.value))}
                    className="w-full accent-[var(--apex-danger)]"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] text-[var(--apex-text-muted)] mb-1">
                    <span>Root Key (Pitch)</span>
                    <span className="font-mono text-[var(--apex-accent)]">MIDI {rootPitch}</span>
                  </div>
                  <select
                    value={rootPitch}
                    onChange={(e) => setRootPitch(Number(e.target.value))}
                    className="w-full bg-[var(--apex-canvas)] border border-[var(--apex-border)] text-[var(--apex-text)] text-xs rounded p-1"
                  >
                    <option value={36}>C2 (Sub / Kick 36)</option>
                    <option value={48}>C3 (Low Octave 48)</option>
                    <option value={60}>C4 (Standard Middle C 60)</option>
                    <option value={72}>C5 (High Lead 72)</option>
                  </select>
                </div>
              </div>

              {/* Target Channel Destination */}
              <div className="pt-2 border-t border-[var(--apex-border)] flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <span className="text-xs text-[var(--apex-text-muted)]">Target Channel:</span>
                  <select
                    value={targetChannelId}
                    onChange={(e) => setTargetChannelId(e.target.value)}
                    className="bg-[var(--apex-canvas)] border border-[var(--apex-border)] text-[var(--apex-text)] text-xs rounded p-1.5 font-bold"
                  >
                    {channels.map(ch => (
                      <option key={ch.id} value={ch.id}>{ch.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                  <button
                    onClick={handleCreateNew}
                    disabled={isCurrentSampleUnavailable}
                    title={isCurrentSampleUnavailable ? 'Sample audio is missing — re-import the file before using this sample.' : undefined}
                    className={`flex-1 sm:flex-none px-3 py-1.5 font-bold text-xs rounded transition flex items-center justify-center gap-1 ${
                      isCurrentSampleUnavailable
                        ? 'bg-[var(--apex-surface-2)] text-[var(--apex-text-3)] cursor-not-allowed'
                        : 'bg-[var(--apex-surface-3)] hover:bg-[var(--apex-state-hover)] text-[var(--apex-text)]'
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create As New Channel</span>
                  </button>

                  <button
                    onClick={handleAssign}
                    disabled={isCurrentSampleUnavailable}
                    title={isCurrentSampleUnavailable ? 'Sample audio is missing — re-import the file before assigning it.' : undefined}
                    className={`flex-1 sm:flex-none px-4 py-1.5 font-bold text-xs rounded transition flex items-center justify-center gap-1 shadow ${
                      isCurrentSampleUnavailable
                        ? 'bg-[var(--apex-surface-2)] text-[var(--apex-text-3)] cursor-not-allowed'
                        : 'bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)]'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Assign to Channel</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-[var(--apex-panel)] border border-[var(--apex-border)] rounded-xl p-4 text-center text-xs text-[var(--apex-text-3)]">
              No custom sample loaded yet. Drop an audio file or click browse above.
            </div>
          )}
        </div>
      </div>
    </ModalFrame>
  );
};
