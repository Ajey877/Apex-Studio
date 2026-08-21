import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, 
  Square, 
  Volume2, 
  Layers, 
  Check, 
  X, 
  Sliders,
  AlertCircle
} from 'lucide-react';
import { AudioRecording } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';

interface AudioRecorderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveRecording: (recording: AudioRecording, targetTrackIndex: number) => void;
}

export const AudioRecorderModal: React.FC<AudioRecorderModalProps> = ({
  isOpen,
  onClose,
  onSaveRecording
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [targetTrack, setTargetTrack] = useState(4); // default Track 5 Vocals
  const [recordedTake, setRecordedTake] = useState<AudioRecording | null>(null);
  const [monitorAudio, setMonitorAudio] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Metering & visualizer animation
  useEffect(() => {
    if (!isOpen) return;

    let animId: number;
    const updateLevel = () => {
      if (isRecording) {
        const peak = audioEngine.getRecordingPeak();
        setInputLevel(peak);

        if (canvasRef.current) {
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#0a0a0b';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.strokeStyle = '#ff6e00';
            ctx.lineWidth = 2;
            ctx.beginPath();

            const mid = canvas.height / 2;
            ctx.moveTo(0, mid);
            for (let x = 0; x < canvas.width; x += 4) {
              const y = mid + (Math.random() * 2 - 1) * (peak * mid * 0.9);
              ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
      }
      animId = requestAnimationFrame(updateLevel);
    };

    animId = requestAnimationFrame(updateLevel);
    return () => cancelAnimationFrame(animId);
  }, [isOpen, isRecording]);

  // Timer loop
  useEffect(() => {
    let timer: any;
    if (isRecording) {
      timer = setInterval(() => {
        setRecordSeconds(s => s + 1);
      }, 1000);
    } else {
      setRecordSeconds(0);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  if (!isOpen) return null;

  const handleStart = async () => {
    try {
      await audioEngine.startAudioRecording();
      setIsRecording(true);
      setRecordedTake(null);
    } catch (err) {
      console.error(err);
    }
  };

  const handleStop = async () => {
    setIsRecording(false);
    const rec = await audioEngine.stopAudioRecording();
    if (rec) {
      setRecordedTake(rec);
    }
  };

  const handleApplyToPlaylist = () => {
    if (recordedTake) {
      onSaveRecording(recordedTake, targetTrack);
      onClose();
    }
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(mins).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div id="audio-recorder-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden text-[#b0b0b0]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <Mic className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white tracking-tight">HIGH-FIDELITY VOCAL & INSTRUMENT RECORDER</h3>
              <p className="text-[10px] text-[#777]">Low-latency 48kHz Direct-to-Disk Capture</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* LCD Live Waveform & Duration Display */}
          <div className="bg-[#0a0a0b] border border-[#333336] rounded-lg p-4 flex flex-col items-center justify-center space-y-2">
            <div className="text-2xl font-mono font-bold text-white flex items-center gap-2">
              {isRecording && <div className="w-3 h-3 bg-[#ff0000] rounded-full animate-ping" />}
              <span>{formatTime(recordSeconds)}</span>
            </div>

            <canvas
              ref={canvasRef}
              width={360}
              height={50}
              className="w-full h-12 bg-[#121214] rounded border border-[#222225]"
            />

            <div className="w-full flex items-center justify-between text-[10px] text-[#777] font-mono">
              <span>INPUT LEVEL: {Math.round(inputLevel * 100)}%</span>
              <span className={isRecording ? 'text-[#ff6e00] font-bold' : ''}>
                {isRecording ? 'STATUS: RECORDING (48kHz)' : 'STATUS: READY'}
              </span>
            </div>
          </div>

          {/* Record / Stop Action Button */}
          <div className="flex items-center justify-center gap-4">
            {!isRecording ? (
              <button
                onClick={handleStart}
                className="flex items-center gap-2 px-6 py-2.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-sm rounded shadow-lg transition active:scale-95"
              >
                <div className="w-3 h-3 bg-black rounded-full" />
                <span>START RECORDING</span>
              </button>
            ) : (
              <button
                onClick={handleStop}
                className="flex items-center gap-2 px-6 py-2.5 bg-[#ff0000] hover:bg-red-600 text-white font-bold text-sm rounded shadow-lg transition active:scale-95 animate-pulse"
              >
                <Square className="w-4 h-4 fill-current" />
                <span>STOP & SAVE TAKE</span>
              </button>
            )}
          </div>

          {/* Target Track & Direct Placement */}
          {recordedTake && (
            <div className="p-3 bg-[#1a1a1d] border border-[#ff6e00]/50 rounded-lg space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-white">RECORDED TAKE:</span>
                <span className="text-[#ff6e00] font-mono font-bold">{recordedTake.durationSeconds.toFixed(1)}s Duration</span>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-[#777]">Insert onto Track Lane:</span>
                <select
                  value={targetTrack}
                  onChange={(e) => setTargetTrack(Number(e.target.value))}
                  className="bg-[#121214] text-white text-xs px-2.5 py-1 rounded border border-[#333336] focus:outline-none"
                >
                  <option value={0}>Track 1 (Drums)</option>
                  <option value={1}>Track 2 (Bass)</option>
                  <option value={2}>Track 3 (Synths)</option>
                  <option value={3}>Track 4 (Melody)</option>
                  <option value={4}>Track 5 (Lead Vocals)</option>
                  <option value={5}>Track 6 (Backing Vocals)</option>
                </select>
              </div>

              <button
                onClick={handleApplyToPlaylist}
                className="w-full py-2 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center justify-center gap-1.5"
              >
                <Check className="w-4 h-4" />
                <span>PLACE TAKE ON PLAYLIST ARRANGER</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
