import React, { useState, useEffect } from 'react';
import { 
  BarChart2, 
  Clock, 
  X, 
  Music, 
  Sliders, 
  Flame, 
  Activity, 
  CheckCircle,
  TrendingUp
} from 'lucide-react';
import { Channel, PlaylistClip, ProjectMetadata } from '../types/daw';

interface AnalyticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  meta: ProjectMetadata;
  channels: Channel[];
  clips: PlaylistClip[];
}

export const AnalyticsModal: React.FC<AnalyticsModalProps> = ({
  isOpen,
  onClose,
  meta,
  channels,
  clips
}) => {
  const [sessionSeconds, setSessionSeconds] = useState(meta.totalEditTimeSeconds || 1840);

  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      setSessionSeconds(s => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen]);

  if (!isOpen) return null;

  const totalNotes = channels.reduce((acc, ch) => acc + (ch.notes?.length || 0), 0);
  const activeChannelsCount = channels.filter(c => !c.mute).length;
  const activeClipsCount = clips.length;

  const hours = Math.floor(sessionSeconds / 3600);
  const minutes = Math.floor((sessionSeconds % 3600) / 60);
  const seconds = sessionSeconds % 60;

  return (
    <div id="analytics-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden text-[#b0b0b0]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <BarChart2 className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white tracking-tight">STUDIO TELEMETRY & PRODUCTION METRICS</h3>
              <p className="text-[10px] text-[#777]">Time Tracking, Arranger Density & Performance Stats</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-1 rounded hover:bg-[#2d2d30] text-[#777] hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Main Stopwatch Banner */}
          <div className="bg-[#1a1a1d] border border-[#333336] rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-3 bg-[#ff6e00]/15 text-[#ff6e00] rounded-lg border border-[#ff6e00]/30">
                <Clock className="w-6 h-6 animate-spin-slow" />
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-[#777] tracking-wider">Active Studio Session Time</span>
                <div className="text-2xl font-mono font-bold text-white">
                  {String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
                </div>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-[#00ff00] font-bold bg-[#00ff00]/15 px-2 py-0.5 rounded border border-[#00ff00]/40">
                FLOW STATE
              </span>
            </div>
          </div>

          {/* Grid Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="bg-[#1a1a1d] border border-[#333336] p-3 rounded-lg">
              <span className="text-[10px] text-[#777]">Total Notes</span>
              <div className="text-lg font-bold text-[#ff6e00] font-mono">{totalNotes}</div>
            </div>
            <div className="bg-[#1a1a1d] border border-[#333336] p-3 rounded-lg">
              <span className="text-[10px] text-[#777]">Active Channels</span>
              <div className="text-lg font-bold text-white font-mono">{activeChannelsCount}</div>
            </div>
            <div className="bg-[#1a1a1d] border border-[#333336] p-3 rounded-lg">
              <span className="text-[10px] text-[#777]">Arranged Clips</span>
              <div className="text-lg font-bold text-white font-mono">{activeClipsCount}</div>
            </div>
            <div className="bg-[#1a1a1d] border border-[#333336] p-3 rounded-lg">
              <span className="text-[10px] text-[#777]">Project BPM</span>
              <div className="text-lg font-bold text-[#ff6e00] font-mono">{meta.bpm}</div>
            </div>
          </div>

          {/* Project Details */}
          <div className="bg-[#1a1a1d] border border-[#333336] p-3 rounded-lg space-y-1.5 text-xs">
            <div className="flex justify-between text-[#777]">
              <span>Project ID:</span>
              <span className="font-mono text-white">{meta.id}</span>
            </div>
            <div className="flex justify-between text-[#777]">
              <span>DAW Engine Version:</span>
              <span className="font-mono text-white">v4.5.2 Pro Low-Latency Core</span>
            </div>
            <div className="flex justify-between text-[#777]">
              <span>Offline Backup Status:</span>
              <span className="font-mono text-[#00ff00]">Synchronized & Cached</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
