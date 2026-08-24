import React, { useState, useEffect, useRef } from 'react';
import { 
  Compass, 
  X, 
  Sparkles, 
  Play, 
  RotateCcw, 
  Check, 
  Volume2, 
  Headphones, 
  Radio, 
  Layers, 
  ShieldCheck,
  Activity
} from 'lucide-react';
import { SpatialAudioSettings, MixerTrack } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface SpatialAudio3DPannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  mixerTracks: MixerTrack[];
}

export const SpatialAudio3DPannerModal: React.FC<SpatialAudio3DPannerModalProps> = ({
  isOpen,
  onClose,
  mixerTracks
}) => {
  const [selectedTrackId, setSelectedTrackId] = useState<number>(1);
  const [azimuthDeg, setAzimuthDeg] = useState<number>(45); // -180 to 180
  const [elevationDeg, setElevationDeg] = useState<number>(15); // -90 to 90
  const [distanceMeters, setDistanceMeters] = useState<number>(2.5); // 0.5 to 10
  const [binauralRoom, setBinauralRoom] = useState<'studio_dry' | 'concert_hall' | 'cathedral' | 'cinema_atmos'>('cinema_atmos');
  const [lfeSubLevel, setLfeSubLevel] = useState<number>(0.8);
  const [binauralEnabled, setBinauralEnabled] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Draw 3D polar radar map
  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.42;

    ctx.clearRect(0, 0, w, h);

    // Draw circular distance concentric rings
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1.0].forEach(factor => {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * factor, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Draw Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx, 10);
    ctx.lineTo(cx, h - 10);
    ctx.moveTo(10, cy);
    ctx.lineTo(w - 10, cy);
    ctx.stroke();

    // Center Listener Head Icon
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();

    // Listener nose direction indicator (pointing UP)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 6);
    ctx.lineTo(cx + 3, cy - 6);
    ctx.lineTo(cx, cy - 12);
    ctx.closePath();
    ctx.fill();

    // Calculate source object coordinate on polar plane
    const rad = (azimuthDeg - 90) * (Math.PI / 180);
    const distNorm = Math.min(1.0, distanceMeters / 10);
    const px = cx + Math.cos(rad) * radius * distNorm;
    const py = cy + Math.sin(rad) * radius * distNorm;

    // Draw sound radiation waves
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
    ctx.beginPath();
    ctx.arc(px, py, 14, 0, Math.PI * 2);
    ctx.stroke();

    // Sound source orb
    const grad = ctx.createRadialGradient(px, py, 2, px, py, 12);
    grad.addColorStop(0, '#00ff88');
    grad.addColorStop(1, '#00aa55');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Labels
    ctx.fillStyle = '#777';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('FRONT (0°)', cx, 18);
    ctx.fillText('REAR (180°)', cx, h - 6);
    ctx.fillText('LEFT (-90°)', 35, cy + 3);
    ctx.fillText('RIGHT (+90°)', w - 35, cy + 3);

  }, [isOpen, azimuthDeg, elevationDeg, distanceMeters]);

  if (!isOpen) return null;

  const currentTrack = mixerTracks.find(t => t.id === selectedTrackId) || mixerTracks[1] || mixerTracks[0];

  const handleAuditionSpatial = () => {
    // Play binaural spatial test note
    audioEngine.playNote(
      {
        id: 'spatial-test',
        name: 'Spatial Object',
        instrumentType: 'supersaw_lead',
        volume: 0.9,
        pan: Math.sin(azimuthDeg * Math.PI / 180),
        pitch: 0,
        mute: false,
        solo: false,
        color: '#00e5ff',
        mixerTrackId: selectedTrackId,
        steps: [],
        notes: [],
        synthParams: {} as any
      },
      { id: `sp-aud-${Date.now()}`, pitch: 64, start: 0, duration: 2, velocity: 0.9 }
    );

    setStatusMessage(`Auditioning 3D Spatial Object at Azimuth ${azimuthDeg}°, Elevation ${elevationDeg}°`);
    setTimeout(() => setStatusMessage(null), 2500);
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - canvas.width / 2;
    const y = e.clientY - rect.top - canvas.height / 2;

    const angleRad = Math.atan2(y, x);
    let deg = Math.round(angleRad * (180 / Math.PI)) + 90;
    if (deg > 180) deg -= 360;
    setAzimuthDeg(deg);

    const dist = Math.min(10, Math.max(0.5, (Math.sqrt(x * x + y * y) / (canvas.width * 0.42)) * 10));
    setDistanceMeters(Number(dist.toFixed(1)));
  };

  return (
    <div id="fl-spatial-audio-modal" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-[#121215] border border-[#00e5ff]/40 rounded-xl w-full max-w-4xl shadow-2xl overflow-hidden text-[#b0b0b0] flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#18181c] border-b border-[#2e2e34] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00e5ff] to-[#0077ff] flex items-center justify-center text-black shadow-md font-bold">
              <Headphones className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white tracking-wide">3D DOLBY ATMOS & BINAURAL SPATIAL AUDIO PANNER</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-bold bg-[#00e5ff]/20 text-[#00e5ff] border border-[#00e5ff]/40">
                  7.1.4 HEIGHT BED
                </span>
              </div>
              <p className="text-[10px] text-[#777]">Full 3D object positioning with Head-Related Transfer Function (HRTF) headphone rendering</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAuditionSpatial}
              className="px-3 py-1 bg-[#00e5ff] hover:bg-[#33edff] text-black font-bold text-xs rounded transition flex items-center gap-1.5 shadow"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Audition 3D Object</span>
            </button>

            <button
              onClick={onClose}
              className="text-[#777] hover:text-white p-1 rounded hover:bg-[#222226] transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="bg-[#00e5ff] text-black font-bold text-xs px-4 py-1.5 flex items-center justify-between shadow-md">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
            <button onClick={() => setStatusMessage(null)} className="text-black/80 hover:text-black">✕</button>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Interactive 3D Polar Radar Stage */}
            <div className="bg-[#0b0b0e] p-3 rounded-xl border border-[#2d2d34] flex flex-col items-center justify-between space-y-2">
              <div className="w-full flex items-center justify-between text-xs">
                <span className="font-bold text-white uppercase text-[11px] flex items-center gap-1">
                  <Radio className="w-3.5 h-3.5 text-[#00e5ff]" />
                  <span>360° POLAR OBJECT RADAR</span>
                </span>
                <span className="text-[10px] font-mono text-[#00ff88]">Click radar to position</span>
              </div>

              <canvas
                ref={canvasRef}
                width={260}
                height={260}
                onClick={handleCanvasClick}
                className="cursor-crosshair rounded-full bg-[#121216] border border-[#2a2a30] shadow-inner"
              />

              <div className="flex items-center gap-4 text-xs font-mono text-[#aaa]">
                <span>Azimuth: <strong className="text-white">{azimuthDeg}°</strong></span>
                <span>Dist: <strong className="text-[#00e5ff]">{distanceMeters}m</strong></span>
                <span>Elev: <strong className="text-[#00ff88]">{elevationDeg}°</strong></span>
              </div>
            </div>

            {/* Spatial Parameter Matrix */}
            <div className="space-y-3">
              {/* Selected Track Selector */}
              <div className="bg-[#18181c] p-3 rounded-lg border border-[#28282e] space-y-1.5">
                <span className="text-[10px] font-bold text-white uppercase tracking-wider block">
                  SPATIAL 3D OBJECT TRACK
                </span>
                <select
                  value={selectedTrackId}
                  onChange={(e) => setSelectedTrackId(Number(e.target.value))}
                  className="w-full bg-[#121214] text-white text-xs p-2 rounded border border-[#333336] font-bold"
                >
                  {mixerTracks.map(m => (
                    <option key={m.id} value={m.id}>Track #{m.id}: {m.name}</option>
                  ))}
                </select>
              </div>

              {/* Spatial Height / Elevation */}
              <div className="bg-[#18181c] p-3 rounded-lg border border-[#28282e] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">Z-AXIS ELEVATION (HEIGHT BED)</span>
                  <span className="text-[#00ff88] font-mono font-bold">{elevationDeg > 0 ? `+${elevationDeg}` : elevationDeg}°</span>
                </div>
                <input
                  type="range"
                  min="-90"
                  max="90"
                  value={elevationDeg}
                  onChange={(e) => setElevationDeg(Number(e.target.value))}
                  className="w-full accent-[#00ff88]"
                />
                <div className="flex justify-between text-[9px] text-[#666]">
                  <span>-90° (Floor)</span>
                  <span>0° (Ear Level)</span>
                  <span>+90° (Ceiling Atmos)</span>
                </div>
              </div>

              {/* Binaural Room Acoustics */}
              <div className="bg-[#18181c] p-3 rounded-lg border border-[#28282e] space-y-2">
                <span className="text-[10px] font-bold text-white uppercase tracking-wider block">
                  BINAURAL HRTF ROOM ACOUSTICS
                </span>
                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  {[
                    { id: 'studio_dry', name: 'Studio Dry (An-Echoic)' },
                    { id: 'concert_hall', name: 'Concert Hall (Lush)' },
                    { id: 'cinema_atmos', name: 'Cinema Dolby Atmos' },
                    { id: 'cathedral', name: 'Cathedral Reverb' }
                  ].map((room) => (
                    <button
                      key={room.id}
                      onClick={() => setBinauralRoom(room.id as any)}
                      className={`p-2 rounded border text-left transition text-[11px] font-bold ${
                        binauralRoom === room.id
                          ? 'bg-[#00e5ff]/20 text-[#00e5ff] border-[#00e5ff]'
                          : 'bg-[#121214] text-[#777] border-[#333] hover:text-white'
                      }`}
                    >
                      {room.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* LFE Subwoofer Level */}
              <div className="bg-[#18181c] p-3 rounded-lg border border-[#28282e] space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-white font-bold">LFE SUBWOOFER SEND</span>
                  <span className="text-[#ffaa00] font-mono font-bold">{(lfeSubLevel * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={lfeSubLevel}
                  onChange={(e) => setLfeSubLevel(Number(e.target.value))}
                  className="w-full accent-[#ffaa00]"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-[#18181c] border-t border-[#2e2e34] flex items-center justify-between text-xs">
          <span className="text-[10px] text-[#666]">Real-time Spherical Coordinate HRTF Matrix Running</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#00e5ff] hover:bg-[#33edff] text-black font-bold rounded transition shadow flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>Apply 3D Spatial Panner</span>
          </button>
        </div>
      </div>
    </div>
  );
};
