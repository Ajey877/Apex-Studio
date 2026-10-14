import React, { useState, useEffect, useRef } from 'react';
import { ModalFrame } from './ModalFrame';
import { 
  Sliders, 
  Activity, 
  Zap, 
  Volume2, 
  Check, 
  ShieldCheck, 
  Flame, 
  Radio, 
  X, 
  Layers, 
  RotateCcw,
  Sparkles,
  Gauge
} from 'lucide-react';
import { MasteringSuiteState, MultibandBandSettings, MasterMeasurementSnapshot } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import {
  MASTERING_CONTROL_RANGES,
  applyMasteringControlChange,
  bandRangeLabel,
  formatFrequencyHz,
  isBandAudible,
  resolveCrossoverFrequencies,
  toggleBandMute,
  toggleBandSolo,
} from '../audio/masteringControls';
import type { MasteringBandKey, MasteringControlRange } from '../audio/masteringControls';
import {
  bandAccentKey,
  readMasteringSuitePalette,
  type MasteringBandAccentKey,
  type MasteringSuitePalette,
} from './masteringSuiteTheme';

export type MasteringSuiteTab = 'metering' | 'multiband' | 'imager' | 'maximizer';

interface MasteringSuiteModalProps {
  isOpen: boolean;
  onClose: () => void;
  masteringState: MasteringSuiteState;
  onUpdateMasteringState: (state: MasteringSuiteState) => void;
  isPlaying: boolean;
  /**
   * Tab shown on mount. Optional and defaulted so existing call sites are
   * unaffected; it exists so the control bindings can be rendered and asserted
   * without a DOM to click through.
   */
  initialTab?: MasteringSuiteTab;
}

/**
 * Display tolerance for the loudness-target readout. This is a presentation
 * threshold chosen by the UI; it is not a delivery certification, and the
 * readout says so rather than claiming a platform "pass".
 */
const TARGET_TOLERANCE_DB = 1.5;

/** Master analyser bins: fftSize 512 -> 256 bins spanning DC..Nyquist. */
const MASTER_FFT_BINS = 256;

/**
 * UI-03B — the DOM palette follows the live document theme.
 *
 * Canvas drawing reads the same seam every frame, but the DOM only re-renders
 * when React re-renders, so this hook additionally watches the `data-theme`
 * attribute. Flipping the theme in Settings therefore repaints the inline
 * band/status colours immediately, even if no parent state changed. The seam
 * caches per (document, mode), so the observer fires one cheap read and the
 * same cached object comes back unchanged when the theme did not move — React
 * then skips the re-render.
 */
const useMasteringSuitePalette = (): MasteringSuitePalette => {
  const [palette, setPalette] = useState<MasteringSuitePalette>(() => readMasteringSuitePalette());
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const apply = () => setPalette(readMasteringSuitePalette());
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return palette;
};

/**
 * The controls now drive the shared live/offline master processor. This status
 * reports whether that processor is enabled; it does not claim a loudness or
 * delivery target has been achieved.
 */
const MasteringPathStatus = ({ label, enabled }: { label: string; enabled: boolean }) => (
  <div className={`bg-[var(--apex-chrome-inset)] border rounded-lg px-3 py-2 flex items-center justify-between gap-2 ${enabled ? 'border-[color-mix(in_srgb,var(--apex-success)_45%,transparent)]' : 'border-[color-mix(in_srgb,var(--apex-gold)_45%,transparent)]'}`}>
    <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${enabled ? 'text-[var(--apex-success)]' : 'text-[var(--apex-gold)]'}`}>
      {label}: {enabled ? 'PROCESSING ENABLED' : 'BYPASSED'}
    </span>
    <span className="text-[10px] text-[var(--apex-text-3)] whitespace-nowrap">{enabled ? 'LIVE + OFFLINE PATH' : 'DRY SIGNAL PATH'}</span>
  </div>
);

/**
 * Phase 90 — a labelled range control for a mastering setting.
 *
 * `min`/`max`/`step` come from `MASTERING_CONTROL_RANGES`, the same table the
 * tests read, so the rendered control cannot advertise a range the state layer
 * does not honour. `controlId` is written to the DOM as `data-control-id` so a
 * binding test can find the control without depending on layout or copy.
 *
 * UI-03B: the accent is a CSS colour (a `var(--apex-*)` token or a band accent
 * from the theme seam) applied inline, so it follows the active theme instead
 * of being baked into a class name.
 */
const MasteringControlSlider = ({
  controlId,
  label,
  value,
  range,
  accentColor,
  formatValue,
  onValue,
}: {
  controlId: string;
  label: string;
  value: number;
  range: MasteringControlRange;
  /** CSS colour value: a semantic token reference or a seam palette colour. */
  accentColor: string;
  formatValue: (value: number) => string;
  onValue: (raw: string) => void;
}) => (
  <div>
    <div className="flex justify-between text-[11px] text-[var(--apex-text-2)] mb-1">
      <span>{label}</span>
      <span className="font-mono text-[var(--apex-text)]">{formatValue(value)}</span>
    </div>
    <input
      type="range"
      data-control-id={controlId}
      aria-label={label}
      min={range.min}
      max={range.max}
      step={range.step}
      value={value}
      onChange={(e) => onValue(e.target.value)}
      style={{ accentColor }}
      className="w-full"
    />
  </div>
);

/** Solo/Mute pair for one band. Shows the state that will actually be heard. */
const MasteringBandSwitches = ({
  band,
  audible,
  solo,
  mute,
  onToggleSolo,
  onToggleMute,
}: {
  band: MasteringBandKey;
  audible: boolean;
  solo: boolean;
  mute: boolean;
  onToggleSolo: () => void;
  onToggleMute: () => void;
}) => (
  <div className="flex items-center gap-1.5">
    <button
      type="button"
      data-control-id={`${band}.solo`}
      aria-label={`Solo ${band} band`}
      aria-pressed={solo}
      onClick={onToggleSolo}
      className={`flex-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border transition ${
        solo
          ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] border-[var(--apex-accent)]'
          : 'bg-[var(--apex-chrome-inset)] text-[var(--apex-text-3)] border-[var(--apex-border)] hover:border-[var(--apex-accent)]'
      }`}
    >
      Solo
    </button>
    <button
      type="button"
      data-control-id={`${band}.mute`}
      aria-label={`Mute ${band} band`}
      aria-pressed={mute}
      onClick={onToggleMute}
      className={`flex-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border transition ${
        mute
          ? 'bg-[var(--apex-danger)] text-[var(--apex-state-recording-fg)] border-[var(--apex-danger)]'
          : 'bg-[var(--apex-chrome-inset)] text-[var(--apex-text-3)] border-[var(--apex-border)] hover:border-[var(--apex-danger)]'
      }`}
    >
      Mute
    </button>
    <span className="text-[9px] font-mono text-[var(--apex-text-3)] whitespace-nowrap">
      {audible ? 'AUDIBLE' : 'SILENCED'}
    </span>
  </div>
);

/** Per-band presentation. The three cards are identical apart from these values. */
interface BandCardConfig {
  band: MasteringBandKey;
  title: string;
  /** UI-03B: band identity marker; the accent itself comes from the theme seam. */
  accentKey: MasteringBandAccentKey;
  grLabel: string;
}

const BAND_CARDS: readonly BandCardConfig[] = [
  { band: 'lowBand', title: 'LOW BAND', accentKey: bandAccentKey('lowBand'), grLabel: 'GR (Low)' },
  { band: 'midBand', title: 'MID BAND', accentKey: bandAccentKey('midBand'), grLabel: 'GR (Mid)' },
  { band: 'highBand', title: 'HIGH BAND', accentKey: bandAccentKey('highBand'), grLabel: 'GR (High)' },
];

/**
 * One multiband strip: the compressor controls plus the band's solo/mute.
 *
 * The frequency range in the header is derived from the live crossover values
 * rather than written out, so moving a crossover updates every band label that
 * depends on it.
 *
 * UI-03B: the band accent (dot, gain readout, slider thumbs) comes from the
 * theme seam. It is an intentional band identity colour, not a chrome token:
 * Dark keeps the exact legacy literals, Light keeps the hue but darkens it
 * enough to stay legible on the light card surface.
 */
const MasteringBandCard = ({
  config,
  state,
  rangeLabel,
  accent,
  onUpdate,
}: {
  config: BandCardConfig;
  state: MasteringSuiteState;
  rangeLabel: string;
  accent: string;
  onUpdate: (next: MasteringSuiteState) => void;
}) => {
  const band = state[config.band];
  const gainText = band.gain > 0 ? `+${band.gain}` : `${band.gain}`;
  const apply = (target: `${MasteringBandKey}.attack` | `${MasteringBandKey}.release` | `${MasteringBandKey}.knee`) =>
    (raw: string) => onUpdate(applyMasteringControlChange(state, target, raw));

  return (
    <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between border-b border-[var(--apex-border)] pb-2">
        <div className="flex items-center gap-1.5">
          <div data-band-accent={config.accentKey} className="w-2 h-2 rounded-full" style={{ backgroundColor: accent }} />
          <span className="text-xs font-bold text-[var(--apex-text)]">{config.title} ({rangeLabel})</span>
        </div>
        <span className="text-[10px] font-mono" style={{ color: accent }}>{gainText} dB</span>
      </div>

      <div className="space-y-2 text-xs">
        <div>
          <div className="flex justify-between text-[11px] text-[var(--apex-text-2)] mb-1">
            <span>Threshold</span>
            <span className="font-mono text-[var(--apex-text)]">{band.threshold} dB</span>
          </div>
          <input
            type="range" min="-48" max="0" step="1"
            data-control-id={`${config.band}.threshold`}
            aria-label={`Threshold ${config.band} band`}
            value={band.threshold}
            onChange={(e) => onUpdate({ ...state, [config.band]: { ...band, threshold: Number(e.target.value) } })}
            style={{ accentColor: accent }}
            className="w-full"
          />
        </div>

        <div>
          <div className="flex justify-between text-[11px] text-[var(--apex-text-2)] mb-1">
            <span>Gain Makeup</span>
            <span className="font-mono text-[var(--apex-text)]">{band.gain} dB</span>
          </div>
          <input
            type="range" min="-12" max="12" step="0.5"
            data-control-id={`${config.band}.gain`}
            aria-label={`Gain makeup ${config.band} band`}
            value={band.gain}
            onChange={(e) => onUpdate({ ...state, [config.band]: { ...band, gain: Number(e.target.value) } })}
            style={{ accentColor: accent }}
            className="w-full"
          />
        </div>

        <div>
          <div className="flex justify-between text-[11px] text-[var(--apex-text-2)] mb-1">
            <span>Compression Ratio</span>
            <span className="font-mono text-[var(--apex-text)]">{band.ratio}:1</span>
          </div>
          <input
            type="range" min="1" max="12" step="0.5"
            data-control-id={`${config.band}.ratio`}
            aria-label={`Compression ratio ${config.band} band`}
            value={band.ratio}
            onChange={(e) => onUpdate({ ...state, [config.band]: { ...band, ratio: Number(e.target.value) } })}
            style={{ accentColor: accent }}
            className="w-full"
          />
        </div>

        <MasteringControlSlider
          controlId={`${config.band}.attack`}
          label="Attack"
          value={band.attack}
          range={MASTERING_CONTROL_RANGES.bandAttack}
          accentColor={accent}
          formatValue={(v) => `${v} ms`}
          onValue={apply(`${config.band}.attack`)}
        />

        <MasteringControlSlider
          controlId={`${config.band}.release`}
          label="Release"
          value={band.release}
          range={MASTERING_CONTROL_RANGES.bandRelease}
          accentColor={accent}
          formatValue={(v) => `${v} ms`}
          onValue={apply(`${config.band}.release`)}
        />

        <MasteringControlSlider
          controlId={`${config.band}.knee`}
          label="Knee"
          value={band.knee}
          range={MASTERING_CONTROL_RANGES.bandKnee}
          accentColor={accent}
          formatValue={(v) => `${v} dB`}
          onValue={apply(`${config.band}.knee`)}
        />

        <MasteringBandSwitches
          band={config.band}
          audible={isBandAudible(state, config.band)}
          solo={band.solo}
          mute={band.mute}
          onToggleSolo={() => onUpdate(toggleBandSolo(state, config.band))}
          onToggleMute={() => onUpdate(toggleBandMute(state, config.band))}
        />
      </div>

      {/* Reduction Meter */}
      <div className="bg-[var(--apex-chrome-inset)] p-2 rounded border border-[var(--apex-border)] flex items-center justify-between text-[10px] font-mono">
        <span className="text-[var(--apex-text-2)]">{config.grLabel}</span>
        <span className="text-[var(--apex-text-3)]">NOT MEASURED — compressor in path, no GR metering</span>
      </div>
    </div>
  );
};

const MASTERING_PRESETS = [
  {
    name: 'Streaming Standard (-14 LUFS)',
    desc: 'Transparent loudness reference for Spotify, Apple Music & YouTube — LUFS target is metering reference only, processed by the mastering chain when enabled.',
    lufsTarget: -14.0,
    lowGain: 0.5,
    midGain: -0.2,
    highGain: 1.2,
    lowThresh: -18,
    midThresh: -22,
    highThresh: -20,
    maximizerThresh: -3.5,
    maximizerCeiling: -0.2,
    stereoSpread: 1.15
  },
  {
    name: 'Club & Beatport Banger (-9 LUFS)',
    desc: 'Dense, aggressive master with heavy sub punch and pushed transients processed by the mastering chain.',
    lufsTarget: -9.0,
    lowGain: 2.5,
    midGain: 0.5,
    highGain: 2.0,
    lowThresh: -14,
    midThresh: -16,
    highThresh: -14,
    maximizerThresh: -7.0,
    maximizerCeiling: -0.1,
    stereoSpread: 1.3
  },
  {
    name: 'Warm Analog Tape',
    desc: 'Gentle glue compression with rounded highs and cohesive low-end saturation.',
    lufsTarget: -13.0,
    lowGain: 1.8,
    midGain: 0.8,
    highGain: -0.5,
    lowThresh: -20,
    midThresh: -24,
    highThresh: -26,
    maximizerThresh: -4.0,
    maximizerCeiling: -0.3,
    stereoSpread: 1.05
  },
  {
    name: 'Modern Trap & Hip-Hop 808',
    desc: 'Monophonic ultra-tight sub-bass (<120Hz) with crisp hi-hat air and punchy snare presence.',
    lufsTarget: -10.5,
    lowGain: 3.2,
    midGain: -0.8,
    highGain: 2.5,
    lowThresh: -12,
    midThresh: -18,
    highThresh: -16,
    maximizerThresh: -6.0,
    maximizerCeiling: -0.1,
    stereoSpread: 1.25
  }
];

export const MasteringSuiteModal: React.FC<MasteringSuiteModalProps> = ({
  isOpen,
  onClose,
  masteringState,
  onUpdateMasteringState,
  isPlaying,
  initialTab = 'metering'
}) => {
  const [activeTab, setActiveTab] = useState<MasteringSuiteTab>(initialTab);
  // No seed values: `null` is the honest "nothing has been measured yet" state,
  // and every readout below has to handle it. The default object this replaces
  // carried a plausible integrated LUFS figure, a reassuring peak and a wide
  // correlation, which let the compliance badges read PASS before a single
  // sample of audio existed.
  const [measurement, setMeasurement] = useState<MasterMeasurementSnapshot | null>(null);
  const measurementRef = useRef<MasterMeasurementSnapshot | null>(null);
  const spectrumDataRef = useRef<Uint8Array | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const goniometerCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // UI-03B: DOM colours that cannot be a Tailwind token class (band accents)
  // come from the same seam the canvases read, and re-resolve when the
  // document theme flips.
  const palette = useMasteringSuitePalette();

  // Live polling for meters and spectrum visualizer
  useEffect(() => {
    if (!isOpen) return;

    let animId: number;
    const update = () => {
      // The engine pumps measurement while the transport runs; this surface only
      // reads it. Reading every frame (instead of only while playing) keeps the
      // numbers live *and* makes the "not measuring" state explicit, rather than
      // leaving a frozen figure on screen looking current.
      const next = audioEngine.getMasterLoudnessMetrics();
      measurementRef.current = next;
      setMeasurement(next);
      drawMasterSpectrum();
      drawGoniometer();
      animId = requestAnimationFrame(update);
    };

    animId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animId);
  }, [isOpen]);

  const drawGoniometer = () => {
    const canvas = goniometerCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // UI-03B: chrome colours resolve from the active document theme on every
    // frame (the seam caches per mode), so a theme switch repaints the scope
    // without a reload. Signal colours — the correlation trace semantics —
    // stay intentional data colours from the same seam.
    const colors = readMasteringSuitePalette();

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Scope background follows the theme's inset chrome surface.
    ctx.fillStyle = colors.scopeBackground;
    ctx.fillRect(0, 0, width, height);

    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(centerX, centerY) - 8;

    // Outer grid circles
    ctx.strokeStyle = colors.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.arc(centerX, centerY, radius * 0.6, 0, Math.PI * 2);
    ctx.stroke();

    // 45-degree axis lines (Left / Right / Mid / Side)
    ctx.strokeStyle = colors.gridLineStrong;
    ctx.beginPath();
    ctx.moveTo(centerX, 5); ctx.lineTo(centerX, height - 5); // Mid (M)
    ctx.moveTo(5, centerY); ctx.lineTo(width - 5, centerY); // Side (S)
    ctx.moveTo(centerX - radius * 0.7, centerY + radius * 0.7); ctx.lineTo(centerX + radius * 0.7, centerY - radius * 0.7); // Left
    ctx.moveTo(centerX - radius * 0.7, centerY - radius * 0.7); ctx.lineTo(centerX + radius * 0.7, centerY + radius * 0.7); // Right
    ctx.stroke();

    // Labels
    ctx.fillStyle = colors.axisLabel;
    ctx.font = '8px monospace';
    ctx.fillText('M', centerX + 4, 12);
    ctx.fillText('+S', width - 15, centerY - 4);
    ctx.fillText('L', centerX - radius * 0.7 - 6, centerY - radius * 0.7);
    ctx.fillText('R', centerX + radius * 0.7 + 2, centerY - radius * 0.7);

    // Lissajous trace from the measured Mid/Side of the master bus. No points
    // means no measurement, so the scope stays idle instead of drawing a
    // plausible cluster.
    const current = measurementRef.current;
    const vectors = audioEngine.getStereoVectors(current?.isPumping ? 128 : 32);
    const correlation = current?.phaseCorrelation ?? null;
    if (vectors.length === 0) {
      ctx.fillStyle = colors.idleSignal;
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('NO SIGNAL - STEREO FIELD NOT MEASURED', centerX, centerY + 3);
      ctx.textAlign = 'left';
      return;
    }
    if (correlation === null) {
      ctx.strokeStyle = colors.idleSignal;
    } else if (vectors.length > 0) {
      // Trace colour encodes the measured correlation: coherent / wide /
      // out-of-phase. These are measurement semantics and stay data colours.
      ctx.strokeStyle = correlation > 0.4
        ? colors.correlationCoherent
        : correlation >= 0
          ? colors.correlationWide
          : colors.correlationOutOfPhase;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 8;
      ctx.beginPath();

      vectors.forEach((pt, idx) => {
        const px = centerX + (pt.x * radius * 1.4);
        const py = centerY - (pt.y * radius * 1.4);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });

      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  };

  const drawMasterSpectrum = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // UI-03B: the grid is chrome and follows the theme tokens; the bar ramp is
    // the level colour semantics (green -> orange -> red) and stays a data
    // colour sourced from the same seam.
    const colors = readMasteringSuitePalette();

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Background grid
    ctx.strokeStyle = colors.gridLine;
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Spectrum bars
    const bars = 32;
    const barWidth = width / bars;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, colors.spectrumStops[0]);
    gradient.addColorStop(0.6, colors.spectrumStops[1]);
    gradient.addColorStop(1, colors.spectrumStops[2]);

    // Real master FFT, read through the same engine API the mixer already uses.
    // Each bar averages the analyser bins that fall under it, so the shape is a
    // display aggregation of measured data rather than an animation.
    let data = spectrumDataRef.current;
    if (!data || data.length !== MASTER_FFT_BINS) {
      data = new Uint8Array(MASTER_FFT_BINS);
      spectrumDataRef.current = data;
    }
    audioEngine.getMasterFrequencyData(data);

    const binsPerBar = Math.max(1, Math.floor(MASTER_FFT_BINS / bars));
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let b = 0; b < binsPerBar; b++) {
        sum += data[i * binsPerBar + b] ?? 0;
      }
      const level = sum / (binsPerBar * 255);
      const barHeight = level * (height - 10);
      if (barHeight <= 0) continue;

      ctx.fillStyle = gradient;
      ctx.fillRect(i * barWidth + 1, height - barHeight, barWidth - 2, barHeight);
    }
  };

  if (!isOpen) return null;

  const handleApplyPreset = (preset: typeof MASTERING_PRESETS[0]) => {
    onUpdateMasteringState({
      ...masteringState,
      lufsTarget: preset.lufsTarget,
      stereoSpread: preset.stereoSpread,
      maximizerThreshold: preset.maximizerThresh,
      maximizerCeiling: preset.maximizerCeiling,
      lowBand: { ...masteringState.lowBand, gain: preset.lowGain, threshold: preset.lowThresh },
      midBand: { ...masteringState.midBand, gain: preset.midGain, threshold: preset.midThresh },
      highBand: { ...masteringState.highBand, gain: preset.highGain, threshold: preset.highThresh }
    });
  };

  const integratedLufs = measurement?.integratedLufs ?? null;
  const lufsTargetValue = masteringState.lufsTarget ?? -14.0;
  const lufsDelta = integratedLufs === null ? null : integratedLufs - lufsTargetValue;
  // The crossover frequencies the processor will actually configure, after its
  // 100 Hz separation guard and Nyquist cap. Band headers and the crossover
  // readout use this, so the UI describes the filters in use rather than the
  // raw stored numbers.
  const crossover = resolveCrossoverFrequencies(masteringState);
  // The gate every status readout shares: a verdict may only exist when the
  // measurement it refers to exists.
  const isMeasured = measurement?.availability === 'measured';
  const isMeasuring = !!measurement && measurement.isPumping;
  const sampleRateHz = measurement?.sampleRate ?? null;
  const availabilityNote = (() => {
    if (!measurement) return 'WAITING FOR ENGINE';
    switch (measurement.availability) {
      case 'measured': return isMeasuring ? 'MEASURING' : 'LAST MEASUREMENT (TRANSPORT NOT RUNNING)';
      case 'no-audio': return 'NO SIGNAL ON MASTER BUS';
      case 'offline-render': return 'UNAVAILABLE DURING OFFLINE BOUNCE';
      default: return 'ENGINE NOT STARTED';
    }
  })();
  const formatDb = (value: number | null | undefined, decimals = 1, suffix = ''): string =>
    value === null || value === undefined ? '—' : `${value.toFixed(decimals)}${suffix}`;
  const formatSigned = (value: number | null | undefined, decimals = 2): string =>
    value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(decimals)}`;
  // Meter verdicts keep their green/gold/red meaning through the semantic
  // state tokens, so both themes stay readable.
  const complianceClass = (target: number): string => {
    if (integratedLufs === null) return 'text-[var(--apex-text-3)]';
    return Math.abs(integratedLufs - target) <= TARGET_TOLERANCE_DB ? 'text-[var(--apex-success)] font-bold' : 'text-[var(--apex-gold)]';
  };
  const complianceText = (target: number): string => {
    if (integratedLufs === null) return 'NOT MEASURED';
    const delta = integratedLufs - target;
    return Math.abs(delta) <= TARGET_TOLERANCE_DB ? 'ON TARGET' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB`;
  };

  return (
    <ModalFrame labelledBy="mastering-suite-modal-title" onClose={onClose} className="fixed inset-0 z-50 flex items-center justify-center p-3 backdrop-blur-md animate-fade-in select-none">
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-[var(--apex-shadow)] overflow-hidden text-[var(--apex-text-2)]">
        {/* Header */}
        <div className="bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--apex-accent)] to-[var(--apex-accent-strong)] flex items-center justify-center shadow-lg">
              <Activity className="w-4 h-4 text-[var(--apex-state-playing-fg)]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="mastering-suite-modal-title" className="text-sm font-black tracking-wide text-[var(--apex-text)] uppercase">APEX MASTERING SUITE</h2>
                <span className="text-[10px] bg-[var(--apex-state-selected)] text-[var(--apex-accent-strong)] border border-[var(--apex-state-selected-border)] px-1.5 py-0.5 rounded font-mono font-bold">
                  ITU-R BS.1770-4 / EBU R128
                </span>
              </div>
              <p className="text-[11px] text-[var(--apex-text-2)]">
                Master bus measurement: gated loudness, inter-sample peak and stereo field. Processing controls below are
                wired to live and offline master paths when enabled.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              title={masteringState.enabled ? "Bypass master processing" : "Enable master processing"}
              aria-label={masteringState.enabled ? "Bypass master processing" : "Enable master processing"}
              onClick={() => onUpdateMasteringState({ ...masteringState, enabled: !masteringState.enabled })}
              className={`px-3 py-1 text-xs font-bold rounded flex items-center gap-1.5 border text-[var(--apex-text)] ${masteringState.enabled ? 'bg-[color-mix(in_srgb,var(--apex-success)_16%,transparent)] border-[color-mix(in_srgb,var(--apex-success)_45%,transparent)]' : 'bg-[var(--apex-surface-3)] border-[color-mix(in_srgb,var(--apex-gold)_45%,transparent)]'}`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>MASTER CHAIN: {masteringState.enabled ? "ACTIVE DSP" : "BYPASSED"}</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close mastering suite"
              className="p-1 text-[var(--apex-text-3)] hover:text-[var(--apex-text)] hover:bg-[var(--apex-state-hover)] rounded transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center justify-between border-b border-[var(--apex-border)] bg-[var(--apex-canvas)] px-4 py-2">
          <div className="flex items-center gap-1 bg-[var(--apex-chrome-inset)] p-1 rounded-lg border border-[var(--apex-border)]">
            <button
              onClick={() => setActiveTab('metering')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'metering' ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              <Gauge className="w-3.5 h-3.5" />
              <span>LUFS Loudness & Peak</span>
            </button>
            <button
              onClick={() => setActiveTab('multiband')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'multiband' ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>3-Band Multiband Dynamics</span>
            </button>
            <button
              onClick={() => setActiveTab('imager')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'imager' ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>Stereo Imager & Sub Mono</span>
            </button>
            <button
              onClick={() => setActiveTab('maximizer')}
              className={`px-3 py-1 text-xs font-bold rounded-md transition flex items-center gap-1.5 ${
                activeTab === 'maximizer' ? 'bg-[var(--apex-accent)] text-[var(--apex-state-playing-fg)] shadow' : 'text-[var(--apex-text-3)] hover:text-[var(--apex-text)]'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Brickwall Maximizer</span>
            </button>
          </div>

          {/* Quick Target Preset */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-[var(--apex-text-3)]">
            <Sparkles className="w-3.5 h-3.5 text-[var(--apex-accent)]" />
            <span>Target:</span>
            <span className="font-mono font-bold text-[var(--apex-text)] bg-[var(--apex-surface-3)] px-2 py-0.5 rounded border border-[var(--apex-border)]">
              {masteringState.lufsTarget || -14.0} LUFS
            </span>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
          {/* Top Spectrum Preview */}
          <div className="bg-[var(--apex-chrome-inset)] border border-[var(--apex-border)] rounded-xl p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[11px] font-mono text-[var(--apex-text-3)]">
              <span>{`MASTER BUS FFT SPECTRUM (${MASTER_FFT_BINS} BINS${sampleRateHz ? ` · DC-${Math.round(sampleRateHz / 2000)}kHz` : ''})`}</span>
              <span className={isMeasuring ? 'text-[var(--apex-success)]' : 'text-[var(--apex-text-3)]'}>
                {sampleRateHz
                  ? `${(sampleRateHz / 1000).toFixed(1)}kHz · 32-bit float · ${availabilityNote}`
                  : 'NO CONTEXT - SPECTRUM NOT MEASURED'}
              </span>
            </div>
            <canvas ref={canvasRef} width={760} height={60} className="w-full h-14 rounded bg-[var(--apex-chrome-inset)]" />
          </div>

          {/* Tab 1: Metering & LUFS */}
          {activeTab === 'metering' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                {/* Integrated LUFS */}
                <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase tracking-wider mb-0.5">INTEGRATED LUFS</span>
                  <span className={`text-2xl font-mono font-black ${
                    integratedLufs === null
                      ? 'text-[var(--apex-text-3)]'
                      : Math.abs(lufsDelta ?? 0) <= 1.0 ? 'text-[var(--apex-success)]' : (lufsDelta ?? 0) > 1.0 ? 'text-[var(--apex-danger)]' : 'text-[var(--apex-gold)]'
                  }`}>
                    {formatDb(integratedLufs)}
                  </span>
                  <span className="text-[9px] text-[var(--apex-text-3)] mt-0.5 font-mono">
                    {integratedLufs === null
                      ? `Target ${lufsTargetValue} LUFS · ${measurement?.blockCount ?? 0} blocks measured`
                      : `Target ${lufsTargetValue} LUFS (${formatSigned(lufsDelta)} dB)`}
                  </span>
                  <div className="w-full bg-[var(--apex-chrome-inset)] h-1.5 rounded-full mt-2 overflow-hidden border border-[var(--apex-border)]">
                    <div 
                      className="h-full bg-gradient-to-r from-[var(--apex-success)] via-[var(--apex-gold)] to-[var(--apex-danger)]" 
                      style={{ width: `${integratedLufs === null ? 0 : Math.min(100, Math.max(0, (integratedLufs + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>

                {/* Short-Term LUFS */}
                <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase tracking-wider mb-0.5">SHORT-TERM (3s)</span>
                  <span className="text-2xl font-mono font-black text-[var(--apex-text)]">
                    {measurement?.shortTermReady ? formatDb(measurement?.shortTermLufs) : '—'}
                  </span>
                  <span className="text-[9px] text-[var(--apex-text-3)] mt-0.5">
                    {measurement?.shortTermReady
                      ? 'Rolling 3 s average'
                      : `COLLECTING ${Math.min(3, measurement?.measuredSeconds ?? 0).toFixed(1)}s / 3.0s`}
                  </span>
                  <div className="w-full bg-[var(--apex-chrome-inset)] h-1.5 rounded-full mt-2 overflow-hidden border border-[var(--apex-border)]">
                    <div 
                      className="h-full bg-[var(--apex-accent)]" 
                      style={{ width: `${!measurement?.shortTermReady ? 0 : Math.min(100, Math.max(0, ((measurement?.shortTermLufs ?? -30) + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>

                {/* Momentary LUFS */}
                <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase tracking-wider mb-0.5">MOMENTARY (400ms)</span>
                  <span className="text-2xl font-mono font-black text-[var(--apex-cyan)]">
                    {formatDb(measurement?.momentaryLufs)}
                  </span>
                  <span className="text-[9px] text-[var(--apex-text-3)] mt-0.5">
                    {measurement && measurement.blockCount > 0
                      ? `${measurement.gatedBlockCount}/${measurement.blockCount} blocks above gate`
                      : 'NO GATING BLOCKS YET'}
                  </span>
                  <div className="w-full bg-[var(--apex-chrome-inset)] h-1.5 rounded-full mt-2 overflow-hidden border border-[var(--apex-border)]">
                    <div 
                      className="h-full bg-[var(--apex-cyan)]" 
                      style={{ width: `${measurement?.momentaryLufs === null || measurement?.momentaryLufs === undefined ? 0 : Math.min(100, Math.max(0, (measurement.momentaryLufs + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>

                {/* True Peak dBFS */}
                <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3 flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase tracking-wider mb-0.5">
                    TRUE PEAK dBFS ({measurement?.oversampleFactor ? `${measurement.oversampleFactor}× ISP` : 'ISP'})
                  </span>
                  <span className={`text-2xl font-mono font-black ${
                    measurement?.isClipping === null || measurement?.isClipping === undefined ? 'text-[var(--apex-text-3)]' : measurement.isClipping ? 'text-[var(--apex-danger)]' : 'text-[var(--apex-text)]'
                  }`}>
                    {formatDb(measurement?.truePeakDbfs)} dB
                  </span>
                  <span className={`text-[9px] font-bold mt-0.5 ${
                    measurement?.isClipping ? 'text-[var(--apex-danger)]' : measurement?.isClipping === false ? 'text-[var(--apex-success)]' : 'text-[var(--apex-text-3)]'
                  }`}>
                    {measurement?.isClipping === null || measurement?.isClipping === undefined
                      ? 'NOT MEASURED'
                      : measurement.isClipping
                        ? 'OVER 0 dBFS AFTER RECONSTRUCTION'
                        : `HEADROOM ${formatDb(measurement.headroomDb, 1, ' dB')}`}
                  </span>
                  <span className="text-[8px] text-[var(--apex-text-3)] mt-0.5 font-mono">
                    sample peak {formatDb(measurement?.samplePeakDbfs)} dBFS
                  </span>
                  <div className="w-full bg-[var(--apex-chrome-inset)] h-1.5 rounded-full mt-2 overflow-hidden border border-[var(--apex-border)]">
                    <div 
                      className={`h-full ${measurement?.isClipping ? 'bg-[var(--apex-danger)]' : 'bg-[var(--apex-success)]'}`}
                      style={{ width: `${measurement?.truePeakDbfs === null || measurement?.truePeakDbfs === undefined ? 0 : Math.min(100, Math.max(0, (measurement.truePeakDbfs + 30) * 3.3))}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Goniometer + Stereo Phase Correlation Row */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3">
                {/* 2D Goniometer Vector Scope */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-[var(--apex-success)]" />
                      <span>2D GONIOMETER STEREO FIELD SCOPE</span>
                    </span>
                    <span className="text-[10px] font-mono text-[var(--apex-text-3)]">
                      {measurement?.isPumping ? 'Mid/Side from master tap' : 'NOT MEASURING'}
                    </span>
                  </div>
                  <div className="flex items-center justify-center bg-[var(--apex-chrome-inset)] rounded-lg border border-[var(--apex-border)] p-1">
                    <canvas ref={goniometerCanvasRef} width={280} height={140} className="w-full max-w-[280px] h-32" />
                  </div>
                </div>

                {/* Phase Correlation Meter & Streaming Platform Matrix */}
                <div className="flex flex-col justify-between gap-2 text-xs">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[var(--apex-text)]">STEREO PHASE CORRELATION</span>
                      <span className={`font-mono font-bold ${
                        measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined
                          ? 'text-[var(--apex-text-3)]'
                          : measurement.phaseCorrelation > 0.4 ? 'text-[var(--apex-success)]' : measurement.phaseCorrelation >= 0 ? 'text-[var(--apex-gold)]' : 'text-[var(--apex-danger)]'
                      }`}>
                        {formatSigned(measurement?.phaseCorrelation)}
                      </span>
                    </div>
                    {/* Phase Meter Bar: -1.0 to +1.0 */}
                    <div className="relative w-full h-3 bg-[var(--apex-chrome-inset)] rounded border border-[var(--apex-border)] overflow-hidden flex items-center">
                      <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-[var(--apex-text-3)] z-10" />
                      <div 
                        className={`h-full transition-all duration-75 ${
                          measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined
                            ? 'bg-[var(--apex-border)]'
                            : measurement.phaseCorrelation > 0.4 ? 'bg-[var(--apex-success)]' : measurement.phaseCorrelation >= 0 ? 'bg-[var(--apex-gold)]' : 'bg-[var(--apex-danger)]'
                        }`}
                        style={{
                          marginLeft: `${measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined ? 50 : Math.min(50, Math.max(0, (measurement.phaseCorrelation + 1) * 50))}%`,
                          width: `${measurement?.phaseCorrelation === null || measurement?.phaseCorrelation === undefined ? 0 : Math.abs(measurement.phaseCorrelation) * 50}%`
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-[8px] font-mono text-[var(--apex-text-3)]">
                      <span>-1.0 (Out of Phase)</span>
                      <span>0.0 (Wide Stereo)</span>
                      <span>+1.0 (Mono Coherent)</span>
                    </div>
                  </div>

                  {/* Streaming Targets Compliance Badges */}
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold text-[var(--apex-text-2)] uppercase block">STREAMING LOUDNESS TARGETS</span>
                    <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
                      <div className="bg-[var(--apex-surface-3)] p-1.5 rounded border border-[var(--apex-border)] flex items-center justify-between">
                        <span>Spotify (-14 LUFS)</span>
                        <span className={complianceClass(-14)}>
                          {complianceText(-14)}
                        </span>
                      </div>
                      <div className="bg-[var(--apex-surface-3)] p-1.5 rounded border border-[var(--apex-border)] flex items-center justify-between">
                        <span>Apple Music (-16 LUFS)</span>
                        <span className={complianceClass(-16)}>
                          {complianceText(-16)}
                        </span>
                      </div>
                      <div className="bg-[var(--apex-surface-3)] p-1.5 rounded border border-[var(--apex-border)] flex items-center justify-between">
                        <span>Club / Beatport (-9 LUFS)</span>
                        <span className={complianceClass(-9)}>
                          {complianceText(-9)}
                        </span>
                      </div>
                      <div className="bg-[var(--apex-surface-3)] p-1.5 rounded border border-[var(--apex-border)] flex items-center justify-between">
                        <span>YouTube (-14 LUFS)</span>
                        <span className={complianceClass(-14)}>
                          {complianceText(-14)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Multiband Dynamics */}
          {activeTab === 'multiband' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-3">
                <MasteringPathStatus label="3-BAND MULTIBAND COMPRESSOR" enabled={masteringState.enabled} />
              </div>

              {/*
                Band crossover. These two filters decide which band owns which
                frequencies, so the band headers below are derived from them
                instead of carrying a hard-coded range.
              */}
              <div className="md:col-span-3 bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between border-b border-[var(--apex-border)] pb-2">
                  <span className="text-xs font-bold text-[var(--apex-text)] flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-[var(--apex-accent)]" />
                    BAND CROSSOVER
                  </span>
                  <span className="text-[10px] font-mono text-[var(--apex-text-3)]">
                    LOW {formatFrequencyHz(crossover.lowCrossHz)} · HIGH {formatFrequencyHz(crossover.highCrossHz)}
                  </span>
                </div>
                <p className="text-[10px] text-[var(--apex-text-2)]">
                  Second-order biquad splits at the default Q of 1. The three bands are summed after their
                  compressors, so a crossover is where adjacent bands overlap, not a unity-sum alignment. The
                  processor holds the low split at least 100 Hz below the high split and caps both below Nyquist.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <MasteringControlSlider
                    controlId="lowCrossFreq"
                    label="Low Crossover"
                    value={masteringState.lowCrossFreq}
                    range={MASTERING_CONTROL_RANGES.lowCrossFreq}
                    accentColor="var(--apex-accent)"
                    formatValue={(v) => formatFrequencyHz(v)}
                    onValue={(raw) => onUpdateMasteringState(applyMasteringControlChange(masteringState, 'lowCrossFreq', raw))}
                  />
                  <MasteringControlSlider
                    controlId="highCrossFreq"
                    label="High Crossover"
                    value={masteringState.highCrossFreq}
                    range={MASTERING_CONTROL_RANGES.highCrossFreq}
                    accentColor="var(--apex-accent)"
                    formatValue={(v) => formatFrequencyHz(v)}
                    onValue={(raw) => onUpdateMasteringState(applyMasteringControlChange(masteringState, 'highCrossFreq', raw))}
                  />
                </div>
              </div>

              {BAND_CARDS.map((config) => (
                <MasteringBandCard
                  key={config.band}
                  config={config}
                  state={masteringState}
                  rangeLabel={bandRangeLabel(masteringState, config.band)}
                  accent={palette.bands[config.accentKey]}
                  onUpdate={onUpdateMasteringState}
                />
              ))}
            </div>
          )}

          {/* Tab 3: Stereo Imager & Sub Mono */}
          {activeTab === 'imager' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <MasteringPathStatus label="STEREO IMAGER / SUB-MONO" enabled={masteringState.enabled} />
              </div>
              <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-[var(--apex-text)] font-bold text-xs">
                  <Radio className="w-4 h-4 text-[var(--apex-accent)]" />
                  <span>STEREO SPREAD & WIDTH</span>
                </div>
                <p className="text-[11px] text-[var(--apex-text-2)]">Expands stereo side channels while maintaining mono phase correlation.</p>

                <div>
                  <div className="flex justify-between text-xs text-[var(--apex-text-2)] mb-1">
                    <span>Width Multiplier</span>
                    <span className="font-mono text-[var(--apex-accent-strong)]">{Math.round((masteringState.stereoSpread || 1.0) * 100)}%</span>
                  </div>
                  <input 
                    type="range" min="0" max="2.0" step="0.05"
                    value={masteringState.stereoSpread || 1.0}
                    onChange={(e) => onUpdateMasteringState({ ...masteringState, stereoSpread: Number(e.target.value) })}
                    style={{ accentColor: 'var(--apex-accent)' }}
                    className="w-full"
                  />
                </div>
              </div>

              <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-[var(--apex-text)] font-bold text-xs">
                  <Flame className="w-4 h-4 text-[var(--apex-success)]" />
                  <span>SUB BASS MONO COLLAPSE</span>
                </div>
                <p className="text-[11px] text-[var(--apex-text-2)]">Collapses all frequencies below this threshold to mono for punchy club bass translation.</p>

                <div>
                  <div className="flex justify-between text-xs text-[var(--apex-text-2)] mb-1">
                    <span>Mono Cutoff Crossover</span>
                    <span className="font-mono text-[var(--apex-success)]">{masteringState.monoSubFreq || 120} Hz</span>
                  </div>
                  <input 
                    type="range" min="60" max="250" step="10"
                    value={masteringState.monoSubFreq || 120}
                    onChange={(e) => onUpdateMasteringState({ ...masteringState, monoSubFreq: Number(e.target.value) })}
                    style={{ accentColor: 'var(--apex-success)' }}
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tab 4: Brickwall Maximizer */}
          {activeTab === 'maximizer' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <MasteringPathStatus label="MAXIMIZER / BRICKWALL LIMITER" enabled={masteringState.enabled} />
              </div>
              <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-[var(--apex-text)] font-bold text-xs">
                  <Zap className="w-4 h-4 text-[var(--apex-danger)]" />
                  <span>BRICKWALL CEILING & THRESHOLD</span>
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-xs text-[var(--apex-text-2)] mb-1">
                      <span>Maximizer Threshold (Drive)</span>
                      <span className="font-mono text-[var(--apex-text)]">{masteringState.maximizerThreshold || -3.5} dB</span>
                    </div>
                    <input 
                      type="range" min="-12" max="0" step="0.5"
                      value={masteringState.maximizerThreshold || -3.5}
                      onChange={(e) => onUpdateMasteringState({ ...masteringState, maximizerThreshold: Number(e.target.value) })}
                      style={{ accentColor: 'var(--apex-danger)' }}
                      className="w-full"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-[var(--apex-text-2)] mb-1">
                      <span>True Peak Ceiling</span>
                      <span className="font-mono text-[var(--apex-success)]">{masteringState.maximizerCeiling || -0.2} dBFS</span>
                    </div>
                    <input 
                      type="range" min="-1.0" max="0.0" step="0.05"
                      value={masteringState.maximizerCeiling || -0.2}
                      onChange={(e) => onUpdateMasteringState({ ...masteringState, maximizerCeiling: Number(e.target.value) })}
                      style={{ accentColor: 'var(--apex-success)' }}
                      className="w-full"
                    />
                  </div>

                  <MasteringControlSlider
                    controlId="maximizerRelease"
                    label="Release"
                    value={masteringState.maximizerRelease}
                    range={MASTERING_CONTROL_RANGES.maximizerRelease}
                    accentColor="var(--apex-danger)"
                    formatValue={(v) => `${v} ms`}
                    onValue={(raw) => onUpdateMasteringState(applyMasteringControlChange(masteringState, 'maximizerRelease', raw))}
                  />
                  <p className="text-[10px] text-[var(--apex-text-3)] leading-tight">
                    Recovery time of the maximizer compressor after a peak. Short values hold the ceiling tighter and
                    can pump; long values breathe but let transients through. This is compressor release, not lookahead.
                  </p>
                </div>
              </div>

              <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-4 flex flex-col justify-between">
                <div>
                  <span className="text-xs font-bold text-[var(--apex-text)]">INTER-SAMPLE PEAK MEASUREMENT</span>
                  <p className="text-[11px] text-[var(--apex-text-2)] mt-1">
                    The TRUE PEAK readout on the metering tab reconstructs the waveform at
                    {measurement?.oversampleFactor ? ` ${measurement.oversampleFactor}x ` : ' '} oversampling and reports the measured
                    inter-sample maximum. It measures only: nothing here limits, delays or protects the signal.
                  </p>
                </div>
                <div className="bg-[var(--apex-chrome-inset)] p-2.5 rounded border border-[var(--apex-border)] flex flex-col gap-1 text-xs font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--apex-text-2)]">Lookahead / Latency</span>
                    <span className="text-[var(--apex-text-3)] font-bold">No delay — attack 1 ms on / 5 ms off</span>
                  </div>
                  <p className="text-[10px] text-[var(--apex-text-3)] leading-tight">
                    Maximizer is DynamicsCompressor (ratio 20) + 4× oversampled WaveShaper hard clip — no true-peak lookahead buffer.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Mastering Presets Library */}
          <div className="bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-[var(--apex-text)] uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[var(--apex-accent)]" />
                MASTERING PRESETS
              </span>
            </div>
            <p className="text-[10px] text-[var(--apex-text-2)] -mt-1 mb-2">
              Selecting a preset applies its settings to the project. Enabled mastering processors use supported settings in live playback and offline export. Preset LUFS targets are references, not measured compliance guarantees.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {MASTERING_PRESETS.map((preset, idx) => (
                <button
                  key={idx}
                  onClick={() => handleApplyPreset(preset)}
                  className="bg-[var(--apex-surface-3)] hover:bg-[var(--apex-state-hover)] border border-[var(--apex-border)] hover:border-[var(--apex-accent)] p-2.5 rounded-lg text-left transition flex flex-col justify-between gap-1 group"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[var(--apex-text)] group-hover:text-[var(--apex-accent-strong)] transition">{preset.name}</span>
                    <span className="text-[9px] font-mono text-[var(--apex-accent-strong)] bg-[var(--apex-state-selected)] px-1 py-0.5 rounded">{preset.lufsTarget} LUFS</span>
                  </div>
                  <p className="text-[10px] text-[var(--apex-text-3)] line-clamp-2 leading-tight">{preset.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="bg-[var(--apex-panel-header)] border-t border-[var(--apex-border)] px-4 py-2.5 flex items-center justify-between">
          <span className="text-[11px] text-[var(--apex-text-3)] font-mono">
            STATUS: {availabilityNote}
            {' · '}
            {measurement && measurement.blockCount > 0
              ? `${measurement.measuredSeconds.toFixed(1)}s / ${measurement.blockCount} blocks measured`
              : 'NO MEASUREMENT YET'}
            {' · '}
            TRANSPORT: {isPlaying ? 'PLAYING' : 'STOPPED'}
            {measurement && measurement.droppedSampleCount > 0
              ? ` · ${measurement.droppedSampleCount} SAMPLES UNREAD (INCOMPLETE)`
              : ''}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition shadow"
          >
            Close
          </button>
        </div>
      </div>
    </ModalFrame>
  );
};
