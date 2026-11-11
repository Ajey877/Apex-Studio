/**
 * Renderer-side lifetime of ONE genuine VST3 editor window.
 *
 * The plug-in paints its own VST3 editor view into a native OS window owned by
 * the isolated helper process; this module never draws plug-in UI. Its job is
 * the part that must be correct in the renderer:
 *
 *  - poll the validated parameter callbacks so the user can see edits arriving,
 *  - on close (the user clicked the plug-in window's X, or the app asked),
 *    capture the plug-in's final component/controller state,
 *  - hand that state to exactly one project commit, and
 *  - tell the main process whether the state was committed. When it was not
 *    (project replaced, insert removed, renderer shutting down) the main
 *    process persists a recovery record instead of discarding the edits.
 *
 * Nothing here is a sample-accurate audio path: live playback keeps its own
 * prepared runtime, so the editor edits the saved insert state.
 */
import type {
  Vst3EditorContext,
  Vst3EditorOpened,
  Vst3EditorStatus,
  Vst3Effect,
  Vst3State,
  Vst3Bridge,
} from './nativeVst3Types';

export type Vst3EditorPhase = 'opening' | 'open' | 'closing' | 'committed' | 'recovered' | 'failed';

export interface Vst3EditorView {
  phase: Vst3EditorPhase;
  /** Plug-in name for the panel; known after the native view is created. */
  name: string;
  status: string;
  editedParameterIds: number[];
  activeEditIds: number[];
  /** The plug-in can report non-parameter changes via IComponentHandler2::setDirty. */
  dirty: boolean;
  error: string;
}

export interface Vst3EditorHandlers {
  onView: (view: Vst3EditorView) => void;
  /** Must persist the captured state as ONE undoable project change. Throw to
   * refuse (stale project/slot, save failure); the state is then recovered. */
  commit: (state: Vst3State) => Promise<void>;
}

const POLL_INTERVAL_MS = 120;
const MAX_POLL_FAILURES = 3;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The editor operations are optional on the bridge type (browser builds and
 * older preloads have none); a session is never created without all of them. */
export interface Vst3EditorBridge extends Vst3Bridge {
  openEditor: NonNullable<Vst3Bridge['openEditor']>;
  pollEditor: NonNullable<Vst3Bridge['pollEditor']>;
  closeEditor: NonNullable<Vst3Bridge['closeEditor']>;
  finishEditor: NonNullable<Vst3Bridge['finishEditor']>;
}
export function supportsNativeVst3Editor(bridge: Vst3Bridge | undefined): bridge is Vst3EditorBridge {
  return Boolean(bridge && typeof bridge.openEditor === 'function' && typeof bridge.pollEditor === 'function' &&
    typeof bridge.closeEditor === 'function' && typeof bridge.finishEditor === 'function');
}

export class NativeVst3EditorSession {
  private id: string | null = null;
  private view: Vst3EditorView = {
    phase: 'opening', name: '', status: 'Opening the plug-in’s own editor window…',
    editedParameterIds: [], activeEditIds: [], dirty: false, error: '',
  };
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollFailures = 0;
  private finished = false;
  private disposeRequested = false;
  private closeRequested = false;
  private closePromise: Promise<Vst3EditorView> | null = null;

  constructor(
    private readonly bridge: Vst3EditorBridge,
    readonly effect: Vst3Effect,
    readonly context: Vst3EditorContext,
    private readonly handlers: Vst3EditorHandlers,
  ) {}

  get sessionId() { return this.id; }
  get currentView() { return this.view; }
  get isFinished() { return this.finished || this.disposeRequested; }

  private publish(patch: Partial<Vst3EditorView>) {
    this.view = { ...this.view, ...patch };
    this.handlers.onView(this.view);
  }

  /** Creates the native window. Rejects with an actionable message; the saved
   * project state is untouched in every failure path. */
  async open(): Promise<Vst3EditorOpened> {
    let opened: Vst3EditorOpened;
    try {
      opened = await this.bridge.openEditor(this.effect, this.context);
    } catch (error) {
      this.publish({ phase: 'failed', status: 'The plug-in editor could not be opened.', error: message(error) });
      throw error;
    }
    if (!opened || typeof opened.id !== 'string' || opened.classId !== this.effect.classId || opened.controllerAvailable !== true) {
      const error = new Error('The native VST3 editor response was invalid; the saved effect state was not changed.');
      this.publish({ phase: 'failed', status: 'The plug-in editor could not be opened.', error: error.message });
      throw error;
    }
    this.id = opened.id;
    this.publish({
      phase: 'open', name: opened.name,
      status: 'The plug-in’s own editor window is open. Close it to save its final state to this project.',
    });
    // The renderer may have been torn down (or the project replaced) while the
    // native window was being created: release it immediately in that case.
    if (this.disposeRequested) await this.runClose(false);
    else this.schedulePoll();
    return opened;
  }

  private schedulePoll() {
    if (this.pollTimer !== null || this.finished || this.disposeRequested) return;
    this.pollTimer = setTimeout(() => { void this.poll(); }, POLL_INTERVAL_MS);
  }

  private async poll() {
    this.pollTimer = null;
    if (this.finished || this.disposeRequested || !this.id) return;
    const id = this.id;
    try {
      const status = await this.bridge.pollEditor(id);
      if (this.finished || this.disposeRequested || this.id !== id) return;
      this.pollFailures = 0;
      this.applyStatus(status, 'poll');
      if (status.closed) { this.finishWithStatus(status); return; }
    } catch (error) {
      if (this.finished || this.disposeRequested || this.id !== id) return;
      this.pollFailures += 1;
      if (this.pollFailures >= MAX_POLL_FAILURES) {
        this.publish({
          phase: 'failed', status: 'The native editor stopped responding. The saved effect state was not changed.',
          error: message(error),
        });
        await this.release(false);
        this.finished = true;
        return;
      }
    }
    this.schedulePoll();
  }

  private applyStatus(status: Vst3EditorStatus, source: 'poll' | 'close') {
    const edited = new Set(this.view.editedParameterIds);
    for (const item of status.editedParameters) edited.add(item.id);
    let statusText = this.view.status;
    if (status.closed) {
      statusText = source === 'close'
        ? 'Capturing the plug-in’s final state…'
        : 'The plug-in window was closed. Saving its final state…';
    }
    if (status.eventQueueOverflow) {
      statusText = `${statusText} Some intermediate moves were coalesced; the final parameter values are kept.`;
    }
    const patch: Partial<Vst3EditorView> = {
      editedParameterIds: [...edited].sort((a, b) => a - b),
      activeEditIds: status.activeEditIds.slice().sort((a, b) => a - b),
      dirty: status.dirty,
      status: statusText,
    };
    if (status.nativeCloseError) patch.error = `The plug-in reported: ${status.nativeCloseError}`;
    this.publish(patch);
  }

  /** Closes the native window and commits the captured state. Safe to call
   * more than once; concurrent callers share one close. */
  close(): Promise<Vst3EditorView> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    if (!this.id || this.finished) return Promise.resolve(this.view);
    this.closePromise = this.runClose(true);
    return this.closePromise;
  }

  /** Renderer/project teardown. Never commits: the captured state becomes a
   * main-process recovery record so the edits survive the replacement. */
  discard(): Promise<Vst3EditorView> {
    if (this.disposeRequested && this.finished) return Promise.resolve(this.view);
    this.disposeRequested = true;
    this.stopPolling();
    if (!this.id) {
      this.finished = true;
      return Promise.resolve(this.view);
    }
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.runClose(false);
    return this.closePromise;
  }

  private async runClose(commit: boolean): Promise<Vst3EditorView> {
    this.stopPolling();
    this.closeRequested = this.closeRequested || commit;
    const id = this.id;
    if (!id) return this.view;
    if (commit) this.publish({ phase: 'closing', status: 'Closing the plug-in editor and capturing its final state…' });
    let status: Vst3EditorStatus;
    try {
      status = await this.bridge.closeEditor(id);
    } catch (error) {
      this.publish({ phase: 'recovered', status: 'The plug-in state could not be captured; the last known values were kept for recovery.', error: message(error) });
      await this.release(false);
      this.finished = true;
      return this.view;
    }
    if (this.finished) return this.view;
    this.applyStatus(status, 'close');
    if (!status.closed || !status.state) {
      this.publish({ phase: 'recovered', status: 'The plug-in did not provide a usable final state; the last known values were kept for recovery.', error: 'Editor close returned without a captured state.' });
      await this.release(false);
      this.finished = true;
      return this.view;
    }
    if (!commit) {
      this.publish({ phase: 'recovered', status: 'The captured plug-in state was kept as a recovery record because this insert closed with the project.', error: '' });
      await this.release(false);
      this.finished = true;
      return this.view;
    }
    return this.finishWithStatus(status);
  }

  private async finishWithStatus(status: Vst3EditorStatus) {
    this.stopPolling();
    if (this.finished) return this.view;
    this.finished = true;
    if (!status.state) {
      this.publish({ phase: 'recovered', status: 'The plug-in did not provide a final state; the last known values were kept for recovery.', error: 'Missing captured VST3 editor state.' });
      await this.release(false);
      return this.view;
    }
    this.publish({ phase: 'closing', status: 'Saving the plug-in’s final state to this project…' });
    if (this.disposeRequested) {
      this.publish({ phase: 'recovered', status: 'The captured plug-in state was kept as a recovery record because this insert closed with the project.' });
      await this.release(false);
      return this.view;
    }
    try {
      await this.handlers.commit(status.state);
      this.publish({
        phase: 'committed',
        status: 'The plug-in’s final state was saved to this project as one undoable change.',
        error: '',
      });
      await this.release(true);
    } catch (error) {
      // The project/slot changed underneath us (or the save failed). Never
      // overwrite the newer project; the captured state is kept on disk.
      this.publish({
        phase: 'recovered',
        status: 'The captured plug-in state was kept as a recovery record because this insert changed in the meantime.',
        error: message(error),
      });
      await this.release(false);
    }
    return this.view;
  }

  private async release(committed: boolean) {
    this.stopPolling();
    const id = this.id;
    this.id = null;
    if (!id) return;
    try { await this.bridge.finishEditor(id, committed); }
    catch { /* main-process teardown still owns the helper process */ }
  }

  private stopPolling() {
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  /** True once a user-visible close was requested (used by the panel). */
  get closing() { return this.closeRequested || this.view.phase === 'closing'; }
}
