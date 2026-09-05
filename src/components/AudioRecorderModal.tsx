import React, { useState, useEffect, useRef } from 'react';
import { Mic, Square, Pause, Play, Check, X, AlertCircle } from 'lucide-react';
import { AudioRecording } from '../types/daw';
import { audioEngine } from '../audio/audioEngine';
import { RecordingEngine } from '../audio/recordingEngine';

interface AudioRecorderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveRecording: (recording: AudioRecording, targetTrackIndex: number) => void | Promise<void>;
}

export const AudioRecorderModal: React.FC<AudioRecorderModalProps> = ({ isOpen, onClose, onSaveRecording }) => {
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'paused' | 'stopping'>('idle');
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [targetTrack, setTargetTrack] = useState(4);
  const [recordedTake, setRecordedTake] = useState<AudioRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<RecordingEngine | null>(null);

  useEffect(() => {
    if (!engineRef.current) engineRef.current = new RecordingEngine(() => audioEngine.getContext(), { onError: error => setError(error.message) });
    return () => engineRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let animationId = 0;
    const update = () => {
      const engine = engineRef.current;
      if (engine) {
        const peak = engine.getPeak();
        setInputLevel(peak);
        if (engine.getState() === 'recording' || engine.getState() === 'paused') setRecordSeconds(engine.getDurationSeconds());
        const canvas = canvasRef.current;
        if (canvas) {
          const context = canvas.getContext('2d');
          if (context) {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = '#0a0a0b';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.strokeStyle = '#ff6e00';
            context.lineWidth = 2;
            context.beginPath();
            const mid = canvas.height / 2;
            const amplitude = Math.max(1, peak * mid * 0.9);
            context.moveTo(0, mid);
            for (let x = 0; x < canvas.width; x += 4) {
              const y = mid + Math.sin(x * 0.18) * amplitude * (0.35 + 0.65 * Math.abs(Math.sin(x * 0.031)));
              context.lineTo(x, y);
            }
            context.stroke();
          }
        }
      }
      animationId = requestAnimationFrame(update);
    };
    animationId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      engineRef.current?.cancel();
      setRecordingState('idle');
      setRecordSeconds(0);
      setInputLevel(0);
      setError(null);
      setRecordedTake(null);
      setIsApplying(false);
    }
  }, [isOpen]);

  const handleStart = async () => {
    try {
      setError(null);
      setRecordedTake(null);
      await engineRef.current!.start();
      setRecordingState('recording');
    } catch (err) {
      setRecordingState('idle');
      setError(err instanceof Error ? err.message : 'Unable to start audio recording');
    }
  };

  const handlePauseResume = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (recordingState === 'recording') {
      engine.pause();
      setRecordingState('paused');
    } else if (recordingState === 'paused') {
      engine.resume();
      setRecordingState('recording');
    }
  };

  const handleStop = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      setError(null);
      setRecordingState('stopping');
      const result = await engine.stop();
      const recording: AudioRecording = { id: result.id, name: result.name, timestamp: result.timestamp, durationSeconds: result.durationSeconds, audioBlob: result.blob, audioUrl: result.url, waveform: result.waveform };
      setRecordedTake(recording);
      setRecordingState('idle');
      setRecordSeconds(result.durationSeconds);
    } catch (err) {
      setRecordingState('idle');
      setError(err instanceof Error ? err.message : 'Unable to stop audio recording');
    }
  };

  const handleApplyToPlaylist = async () => {
    if (!recordedTake || isApplying) return;
    try {
      setError(null);
      setIsApplying(true);
      await onSaveRecording(recordedTake, targetTrack);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to place recording on the playlist');
      setIsApplying(false);
    }
  };

  const formatTime = (secs: number) => {
    const safe = Math.max(0, Math.floor(secs));
    const mins = Math.floor(safe / 60);
    const seconds = safe % 60;
    return `${String(mins).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  if (!isOpen) return null;

  return (
    <div id="audio-recorder-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden text-[#b0b0b0]">
        <div className="px-5 py-3.5 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between">
          <div className="flex items-center space-x-2.5"><div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center"><Mic className="w-4 h-4 text-[#ff6e00]" /></div><div><h3 className="font-bold text-sm text-white tracking-tight">AUDIO RECORDER</h3><p className="text-[10px] text-[#777]">Real microphone / line-in capture</p></div></div>
          <button onClick={onClose} disabled={recordingState === 'stopping' || isApplying} className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-[#0a0a0b] border border-[#333336] rounded-lg p-4 flex flex-col items-center justify-center space-y-2">
            <div className="text-2xl font-mono font-bold text-white flex items-center gap-2">{(recordingState === 'recording' || recordingState === 'paused') && <div className="w-3 h-3 bg-[#ff0000] rounded-full animate-pulse" />}<span>{formatTime(recordSeconds)}</span></div>
            <canvas ref={canvasRef} width={360} height={50} className="w-full h-12 bg-[#121214] rounded border border-[#222225]" />
            <div className="w-full flex items-center justify-between text-[10px] text-[#777] font-mono"><span>INPUT PEAK: {Math.round(inputLevel * 100)}%</span><span className={(recordingState === 'recording' || recordingState === 'paused') ? 'text-[#ff6e00] font-bold' : ''}>STATUS: {recordingState.toUpperCase()}</span></div>
          </div>
          {error && <div className="flex items-start gap-2 p-3 bg-red-950/30 border border-red-800/50 rounded-lg text-xs text-red-200"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span></div>}
          <div className="flex items-center justify-center gap-3">
            {recordingState === 'idle' && !recordedTake && <button onClick={handleStart} className="flex items-center gap-2 px-6 py-2.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-sm rounded shadow-lg transition active:scale-95"><div className="w-3 h-3 bg-black rounded-full" />START RECORDING</button>}
            {(recordingState === 'recording' || recordingState === 'paused') && <><button onClick={handlePauseResume} className="flex items-center gap-2 px-5 py-2.5 bg-[#222225] hover:bg-[#2d2d30] text-white font-bold text-sm rounded border border-[#333336] transition">{recordingState === 'recording' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}{recordingState === 'recording' ? 'PAUSE' : 'RESUME'}</button><button onClick={handleStop} className="flex items-center gap-2 px-6 py-2.5 bg-[#ff0000] hover:bg-red-600 text-white font-bold text-sm rounded shadow-lg transition active:scale-95"><Square className="w-4 h-4 fill-current" />STOP & SAVE</button></>}
            {recordingState === 'stopping' && <span className="text-xs text-[#777]">Finalizing recording…</span>}
          </div>
          {recordedTake && <div className="p-3 bg-[#1a1a1d] border border-[#ff6e00]/50 rounded-lg space-y-3">
            <div className="flex items-center justify-between text-xs"><span className="font-bold text-white">RECORDED TAKE</span><span className="text-[#ff6e00] font-mono font-bold">{recordedTake.durationSeconds.toFixed(2)}s</span></div>
            <div className="flex items-center justify-between text-xs"><span className="text-[#777]">Insert onto Track Lane:</span><select value={targetTrack} onChange={e => setTargetTrack(Number(e.target.value))} disabled={isApplying} className="bg-[#121214] text-white text-xs px-2.5 py-1 rounded border border-[#333336] focus:outline-none disabled:opacity-50"><option value={0}>Track 1 (Drums)</option><option value={1}>Track 2 (Bass)</option><option value={2}>Track 3 (Synths)</option><option value={3}>Track 4 (Melody)</option><option value={4}>Track 5 (Lead Vocals)</option><option value={5}>Track 6 (Backing Vocals)</option></select></div>
            <div className="h-8 flex items-end gap-px bg-[#0a0a0b] rounded px-1 overflow-hidden">{recordedTake.waveform.slice(0, 128).map((value, index) => <div key={index} className="flex-1 bg-[#ff6e00]" style={{ height: `${Math.max(2, value * 100)}%` }} />)}</div>
            <button onClick={handleApplyToPlaylist} disabled={isApplying} className="w-full py-2 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-wait"><Check className="w-4 h-4" />{isApplying ? 'PLACING TAKE…' : 'PLACE TAKE ON PLAYLIST'}</button>
          </div>}
        </div>
      </div>
    </div>
  );
};
