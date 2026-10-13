import React, { useState } from 'react';
import { ModalFrame } from './ModalFrame';
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
}

export const CollaborationModal: React.FC<CollaborationModalProps> = ({
  isOpen,
  onClose,
  comments,
  collaborators,
  onAddComment,
  onToggleResolveComment
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
    <ModalFrame
      id="collab-modal"
      labelledBy="collab-modal-title"
      onClose={onClose}
      className="fixed inset-0 backdrop-blur-sm z-50 flex items-center justify-center p-4"
    >
      {/* UI-03O: every chrome surface, border, text step and interaction state
          below consumes the existing `--apex-*` semantic tokens. The notes
          workspace keeps its accent identity (tile, tile glyph, share/post CTAs
          and the BAR chip) on `--apex-accent`, which is the token the UI-1C
          compatibility layer already resolved these `#ff6e00` literals to, so
          the rendered identity hue is unchanged. The dead `bg-black/85` scrim is
          gone — ModalFrame supplies the shared themed `--apex-modal-overlay`.

          The collaborator avatar keeps `text-black` next to its data-driven
          `backgroundColor: user.color`: the on-colour belongs to the stored
          colour, not to the theme, exactly like the stored colour itself. */}
      <div className="bg-[var(--apex-surface)] border border-[var(--apex-border)] rounded-xl w-full max-w-xl shadow-2xl overflow-hidden text-[var(--apex-text-2)]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--apex-panel-header)] border-b border-[var(--apex-border)] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 bg-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)] border border-[color-mix(in_srgb,var(--apex-accent)_48%,transparent)] rounded flex items-center justify-center">
              <Users className="w-4 h-4 text-[var(--apex-accent)]" />
            </div>
            <div>
              <h3 id="collab-modal-title" className="font-bold text-sm text-[var(--apex-text)] tracking-tight">
                STUDIO NOTES & COLLABORATION
              </h3>
              <p className="text-[10px] text-[var(--apex-text-3)]">Local project notes & collaboration workspace</p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            aria-label="Close collaboration"
            className="p-1 rounded hover:bg-[var(--apex-state-hover)] text-[var(--apex-text-3)] hover:text-[var(--apex-text)] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Local sharing */}
          <div className="flex items-center justify-between bg-[var(--apex-surface-2)] p-3 rounded-lg border border-[var(--apex-border)] gap-2">
            <div>
              <div className="text-xs font-bold text-[var(--apex-text)]">Local collaboration workspace</div>
              <div className="text-[10px] text-[var(--apex-text-3)]">
                Comments and collaborator data are stored in this project. No live network sync is active.
              </div>
            </div>
            <button
              onClick={handleCopyShareLink}
              className="flex items-center space-x-1.5 px-3 py-1 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] rounded text-xs font-bold transition active:scale-95 shadow"
              title="Copy the current app URL"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
              <span>{copiedLink ? 'LINK COPIED' : 'COPY APP LINK'}</span>
            </button>
          </div>

          {/* Project collaborators stored in the project document.
              This build has no network sync, so no live presence (online/idle)
              may be claimed here: only the stored identity and role are shown. */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--apex-text-3)]">Project Collaborators ({collaborators.length})</div>
            {collaborators.length === 0 ? (
              <p className="text-[10px] text-[var(--apex-text-3)]">No collaborators recorded in this project.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {collaborators.map((user) => (
                  <div key={user.id} className="flex items-center space-x-2 p-2.5 bg-[var(--apex-surface-2)] rounded-lg border border-[var(--apex-border)]">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-black shadow-sm"
                      style={{ backgroundColor: user.color }}
                    >
                      {user.avatar}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-[var(--apex-text)]">{user.name}</div>
                      <div className="text-[9px] text-[var(--apex-text-3)] font-mono">{user.role}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Timeline Bar Comments List.
              UI-03O: the unresolved action keeps its green identity on the
              success wash — but its label follows `--apex-text`. Measured in
              Chromium, the legacy success-on-success-wash combination is
              4.08:1 in Light on the resting wash and 4.33:1 in Dark once the
              hover wash lifts it, both below the 4.5:1 floor for a 9px bold
              label; `--apex-text` measures 11.41:1 and 7.08:1 respectively. */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--apex-text-3)]">
              Timeline Mix Feedback & Annotations ({comments.length})
            </div>

            {comments.length === 0 ? (
              <p className="text-[10px] text-[var(--apex-text-3)]">No studio notes recorded in this project yet.</p>
            ) : (
              <div className="space-y-2">
                {comments.map((comment) => (
                  <div
                    key={comment.id}
                    className={`p-3 rounded-lg border transition ${
                      comment.resolved 
                        ? 'bg-[var(--apex-canvas)] border-[var(--apex-border)] opacity-50'
                        : 'bg-[var(--apex-surface-2)] border-[var(--apex-border)]'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs mb-1">
                      <div className="flex items-center space-x-1.5">
                        <span className="font-bold text-[var(--apex-text)]">{comment.author}</span>
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[var(--apex-canvas)] text-[var(--apex-accent)] border border-[var(--apex-border)]">
                          BAR {comment.barPosition}
                        </span>
                      </div>
                      <button
                        onClick={() => onToggleResolveComment(comment.id)}
                        className={`text-[9px] font-bold px-2 py-0.5 rounded transition ${
                          comment.resolved 
                            ? 'bg-[var(--apex-surface-2)] text-[var(--apex-text-3)]'
                            : 'bg-[color-mix(in_srgb,var(--apex-success)_20%,transparent)] text-[var(--apex-text)] hover:bg-[color-mix(in_srgb,var(--apex-success)_30%,transparent)]'
                        }`}
                      >
                        {comment.resolved ? 'RESOLVED' : 'MARK RESOLVED'}
                      </button>
                    </div>
                    <p className="text-xs text-[var(--apex-text-2)]">{comment.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Post New Comment */}
          <form onSubmit={handlePost} className="p-3 bg-[var(--apex-surface-2)] border border-[var(--apex-border)] rounded-lg space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-[var(--apex-text)] text-[11px]">Leave Studio Note at Bar:</span>
              <select
                value={targetBar}
                onChange={(e) => setTargetBar(Number(e.target.value))}
                className="bg-[var(--apex-canvas)] text-[var(--apex-accent)] font-mono text-xs px-2 py-1 rounded border border-[var(--apex-border)] focus:outline-none"
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
                className="flex-1 bg-[var(--apex-canvas)] border border-[var(--apex-border)] rounded px-3 py-1.5 text-xs text-[var(--apex-text)] placeholder:text-[var(--apex-text-3)] focus:outline-none focus:border-[var(--apex-accent)]"
              />
              <button
                type="submit"
                className="px-4 py-1.5 bg-[var(--apex-accent)] hover:bg-[var(--apex-accent-strong)] text-[var(--apex-state-playing-fg)] font-bold text-xs rounded transition flex items-center space-x-1"
              >
                <Send className="w-3.5 h-3.5" />
                <span>POST</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </ModalFrame>
  );
};
