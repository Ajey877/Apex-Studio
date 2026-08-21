import React, { useState } from 'react';
import { 
  Users, 
  X, 
  MessageSquare, 
  ShieldCheck, 
  Share2, 
  Check, 
  Send, 
  Lock, 
  Radio, 
  Clock,
  Sparkles
} from 'lucide-react';
import { CollabComment, CollabUser } from '../types/daw';

interface CollaborationModalProps {
  isOpen: boolean;
  onClose: () => void;
  comments: CollabComment[];
  collaborators: CollabUser[];
  onAddComment: (text: string, barPosition: number) => void;
  onToggleResolveComment: (commentId: string) => void;
  isEncrypted: boolean;
  onToggleEncryption: () => void;
}

export const CollaborationModal: React.FC<CollaborationModalProps> = ({
  isOpen,
  onClose,
  comments,
  collaborators,
  onAddComment,
  onToggleResolveComment,
  isEncrypted,
  onToggleEncryption
}) => {
  const [newCommentText, setNewCommentText] = useState('');
  const [targetBar, setTargetBar] = useState(4);
  const [copiedLink, setCopiedLink] = useState(false);

  if (!isOpen) return null;

  const handlePost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentText.trim()) return;
    onAddComment(newCommentText.trim(), targetBar);
    setNewCommentText('');
  };

  const handleCopyShareLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div id="collab-modal" className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#141416] border border-[#333336] rounded-xl w-full max-w-xl shadow-2xl overflow-hidden text-[#b0b0b0]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[#1a1a1d] border-b border-[#333336] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[#ff6e00]/15 border border-[#ff6e00]/30 rounded flex items-center justify-center">
              <Users className="w-4 h-4 text-[#ff6e00]" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white tracking-tight">REAL-TIME STUDIO COLLABORATION & FEEDBACK</h3>
              <p className="text-[10px] text-[#777]">Live Multi-User Jamming & Bar-by-Bar Producer Comments</p>
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
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Security & Share Bar */}
          <div className="flex flex-wrap items-center justify-between bg-[#1a1a1d] p-3 rounded-lg border border-[#333336] gap-2">
            <div className="flex items-center space-x-2">
              <button
                onClick={onToggleEncryption}
                className={`flex items-center space-x-1 px-2.5 py-1 rounded text-xs font-bold transition ${
                  isEncrypted 
                    ? 'bg-[#00ff00]/15 text-[#00ff00] border border-[#00ff00]/40' 
                    : 'bg-[#121214] text-[#777] border border-[#333336]'
                }`}
                title="End-to-End Encrypted Project State"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>{isEncrypted ? 'E2EE ENCRYPTED' : 'STANDARD SYNC'}</span>
              </button>
              <span className="text-[10px] text-[#777]">P2P WebRTC data sync active</span>
            </div>

            <button
              onClick={handleCopyShareLink}
              className="flex items-center space-x-1.5 px-3 py-1 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black rounded text-xs font-bold transition active:scale-95 shadow"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
              <span>{copiedLink ? 'INVITE COPIED' : 'INVITE PRODUCER'}</span>
            </button>
          </div>

          {/* Active Collaborators Presence List */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#777]">
              Online Studio Session ({collaborators.length} Producers)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {collaborators.map((user) => (
                <div key={user.id} className="flex items-center justify-between p-2.5 bg-[#1a1a1d] rounded-lg border border-[#333336]">
                  <div className="flex items-center space-x-2">
                    <div 
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-black shadow-sm"
                      style={{ backgroundColor: user.color }}
                    >
                      {user.avatar}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-white">{user.name}</div>
                      <div className="text-[9px] text-[#777] font-mono">{user.role}</div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-1 text-[9px] font-mono text-[#00ff00]">
                    <span className="w-2 h-2 rounded-full bg-[#00ff00] animate-pulse" />
                    <span>{user.status.toUpperCase()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Timeline Bar Comments List */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[#777]">
              Timeline Mix Feedback & Annotations ({comments.length})
            </div>

            <div className="space-y-2">
              {comments.map((comment) => (
                <div
                  key={comment.id}
                  className={`p-3 rounded-lg border transition ${
                    comment.resolved 
                      ? 'bg-[#121214] border-[#222225] opacity-50' 
                      : 'bg-[#1a1a1d] border-[#333336]'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div className="flex items-center space-x-1.5">
                      <span className="font-bold text-white">{comment.author}</span>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#121214] text-[#ff6e00] border border-[#333336]">
                        BAR {comment.barPosition}
                      </span>
                    </div>
                    <button
                      onClick={() => onToggleResolveComment(comment.id)}
                      className={`text-[9px] font-bold px-2 py-0.5 rounded transition ${
                        comment.resolved 
                          ? 'bg-[#222225] text-[#777]' 
                          : 'bg-[#00ff00]/20 text-[#00ff00] hover:bg-[#00ff00]/30'
                      }`}
                    >
                      {comment.resolved ? 'RESOLVED' : 'MARK RESOLVED'}
                    </button>
                  </div>
                  <p className="text-xs text-[#b0b0b0]">{comment.text}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Post New Comment */}
          <form onSubmit={handlePost} className="p-3 bg-[#1a1a1d] border border-[#333336] rounded-lg space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-white text-[11px]">Leave Studio Note at Bar:</span>
              <select
                value={targetBar}
                onChange={(e) => setTargetBar(Number(e.target.value))}
                className="bg-[#121214] text-[#ff6e00] font-mono text-xs px-2 py-1 rounded border border-[#333336] focus:outline-none"
              >
                {Array.from({ length: 16 }).map((_, i) => (
                  <option key={i + 1} value={i + 1}>Bar {i + 1}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={newCommentText}
                onChange={(e) => setNewCommentText(e.target.value)}
                placeholder="e.g. Add sidechain compression on the 808 sub here..."
                className="flex-1 bg-[#121214] border border-[#333336] rounded px-3 py-1.5 text-xs text-white placeholder-[#555] focus:outline-none focus:border-[#ff6e00]"
              />
              <button
                type="submit"
                className="px-4 py-1.5 bg-[#ff6e00] hover:bg-[#ff7d1a] text-black font-bold text-xs rounded transition flex items-center space-x-1"
              >
                <Send className="w-3.5 h-3.5" />
                <span>POST</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
