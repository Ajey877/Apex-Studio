const $ = id => document.getElementById(id);
const MAX_VISIBLE_EVENTS = 1200;
const MAX_CAPTURED_EVENTS = 12000;
const MAX_NOTE_OFF_SEND_ATTEMPTS = 3;
const NOTE_OFF_RETRY_DELAY_MS = 50;
const NOTE_OFF_SETTLE_MS = 30;

const ui = {
  permission: $('permission-status'),
  selectedOutput: $('selected-device-status'),
  secureContext: $('secure-context-status'),
  outputSelect: $('midi-output-select'),
  inputSelect: $('midi-input-select'),
  channelSelect: $('midi-channel-select'),
  pitch: $('note-pitch'),
  velocity: $('note-velocity'),
  gate: $('note-gate-ms'),
  ccNumber: $('cc-number'),
  ccValue: $('cc-value'),
  request: $('request-midi-access-btn'),
  sendNote: $('send-test-note-btn'),
  sendCc: $('send-cc-btn'),
  sustainDown: $('sustain-down-btn'),
  sustainUp: $('sustain-up-btn'),
  panic: $('panic-route-btn'),
  compare: $('compare-loopback-btn'),
  summary: $('loopback-summary'),
  log: $('event-log'),
  downloadJson: $('download-json-btn'),
  downloadCsv: $('download-csv-btn'),
};

let access = null;
let permissionState = 'not-requested';
let nextEventId = 1;
let nextPacketId = 1;
let selectedOutput = null;
let selectedInput = null;
const events = [];
const expectedPackets = [];
const observedPackets = [];
const activeNotesByOutput = new Map();
const sustainChannelsByOutput = new Map();
const sustainTransitionsByOutput = new Map();
const latestQueuedEventPerfMsByOutput = new Map();
const recoveryByOutput = new Map();
const reconnectRecoveryPromisesByOutput = new Map();

for (let channel = 1; channel <= 16; channel += 1) {
  const option = document.createElement('option');
  option.value = String(channel);
  option.textContent = `Channel ${channel}`;
  ui.channelSelect.append(option);
}

function nowMs() {
  return performance.now();
}

function safeNumber(input, min, max, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

function hexByte(value) {
  return `0x${Number(value).toString(16).padStart(2, '0').toUpperCase()}`;
}

function bytesText(bytes) {
  return bytes.map(hexByte).join(' ');
}

function portInfo(port) {
  return {
    id: port?.id ?? null,
    name: port?.name ?? null,
    manufacturer: port?.manufacturer ?? null,
    type: port?.type ?? null,
    state: port?.state ?? 'unknown',
    connection: port?.connection ?? 'unknown',
  };
}

function logEvent(type, detail = {}) {
  const event = {
    eventId: nextEventId++,
    utc: new Date().toISOString(),
    perfTimeMs: nowMs(),
    type,
    permissionState,
    output: selectedOutput ? portInfo(selectedOutput) : null,
    input: selectedInput ? portInfo(selectedInput) : null,
    channel: Number(ui.channelSelect.value) || null,
    ...detail,
  };
  events.push(event);
  if (events.length > MAX_CAPTURED_EVENTS) events.splice(0, events.length - MAX_CAPTURED_EVENTS);
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `${event.utc} · ${event.perfTimeMs.toFixed(3)} ms · ${type} · ${JSON.stringify(detail)}`;
  ui.log.append(line);
  while (ui.log.childElementCount > MAX_VISIBLE_EVENTS) ui.log.firstElementChild?.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
  ui.downloadJson.disabled = false;
  ui.downloadCsv.disabled = false;
  return event;
}

function updateSecureContext() {
  const secure = Boolean(window.isSecureContext);
  ui.secureContext.className = `status ${secure ? 'good' : 'bad'}`;
  ui.secureContext.innerHTML = `<strong>Secure context:</strong> ${secure ? 'Yes' : 'No'}`;
}

function updatePermissionLabel(errorMessage = '') {
  const label = permissionState === 'ready'
    ? 'Granted'
    : permissionState === 'denied'
      ? 'Denied'
      : permissionState === 'unsupported'
        ? 'Unsupported'
        : permissionState === 'error'
          ? 'Error'
          : 'Not requested';
  ui.permission.className = `status ${permissionState === 'ready' ? 'good' : permissionState === 'denied' || permissionState === 'error' ? 'bad' : ''}`;
  const heading = document.createElement('strong');
  heading.textContent = 'Permission:';
  ui.permission.replaceChildren(heading, document.createTextNode(` ${label}${errorMessage ? ` — ${errorMessage}` : ''}`));
}

function hasPendingNoteRelease(portId) {
  return [...getRouteState(portId, false).values()].some(note => note.noteOffState === 'pending');
}

function updateSelectedOutputLabel() {
  const info = selectedOutput ? portInfo(selectedOutput) : null;
  const label = info
    ? `${info.name || 'Unnamed output'} · ${info.id} · ${info.state}/${info.connection}`
    : 'None';
  const heading = document.createElement('strong');
  heading.textContent = 'Selected output:';
  ui.selectedOutput.replaceChildren(heading, document.createTextNode(` ${label}`));
  const reconnectRecoveryPending = Boolean(selectedOutput && recoveryByOutput.has(selectedOutput.id));
  const noteReleasePending = Boolean(selectedOutput && hasPendingNoteRelease(selectedOutput.id));
  const recoveryPending = reconnectRecoveryPending || noteReleasePending;
  const ready = Boolean(selectedOutput && selectedOutput.state === 'connected' && selectedOutput.connection === 'open' && !recoveryPending);
  if (reconnectRecoveryPending) ui.selectedOutput.append(document.createTextNode(' · reconnect recovery pending'));
  else if (noteReleasePending) ui.selectedOutput.append(document.createTextNode(' · note release pending'));
  ui.sendNote.disabled = !ready;
  ui.sendCc.disabled = !ready;
  ui.sustainDown.disabled = !ready;
  ui.sustainUp.disabled = !ready;
  ui.panic.disabled = !ready;
  ui.compare.disabled = !(selectedOutput && selectedInput);
}

function makeOption(value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  return option;
}

function renderPorts() {
  const previousOutputId = selectedOutput?.id ?? ui.outputSelect.value;
  const previousInputId = selectedInput?.id ?? ui.inputSelect.value;
  ui.outputSelect.replaceChildren();
  ui.inputSelect.replaceChildren(makeOption('', 'No input selected'));

  const outputs = access ? [...access.outputs.values()] : [];
  const inputs = access ? [...access.inputs.values()] : [];
  if (
    selectedOutput?.state === 'disconnected' &&
    !outputs.some(port => port.id === selectedOutput.id)
  ) {
    outputs.unshift(selectedOutput);
  }
  if (outputs.length === 0) ui.outputSelect.append(makeOption('', 'No MIDI outputs detected'));
  for (const output of outputs) {
    const info = portInfo(output);
    ui.outputSelect.append(makeOption(output.id, `${info.id} · ${info.manufacturer || 'Unknown maker'} · ${info.name || 'Unnamed'} · ${info.state}/${info.connection}`));
  }
  for (const input of inputs) {
    const info = portInfo(input);
    ui.inputSelect.append(makeOption(input.id, `${info.id} · ${info.manufacturer || 'Unknown maker'} · ${info.name || 'Unnamed'} · ${info.state}/${info.connection}`));
  }

  if (outputs.some(port => port.id === previousOutputId)) {
    ui.outputSelect.value = previousOutputId;
  } else if (!previousOutputId && outputs.length > 0) {
    ui.outputSelect.value = outputs[0].id;
  } else {
    ui.outputSelect.value = '';
  }
  if (inputs.some(port => port.id === previousInputId)) ui.inputSelect.value = previousInputId;
  else ui.inputSelect.value = '';
  selectedOutput = access?.outputs.get(ui.outputSelect.value)
    ?? outputs.find(port => port.id === ui.outputSelect.value)
    ?? null;
  selectedInput = access?.inputs.get(ui.inputSelect.value) ?? null;
  updateSelectedOutputLabel();
}

async function openOutputPort(port) {
  if (!port || port.state !== 'connected') return false;
  try {
    if (typeof port.open === 'function' && port.connection !== 'open') await port.open();
    const ready = port.state === 'connected' && (port.connection === undefined || port.connection === 'open');
    logEvent(ready ? 'output-open' : 'output-not-ready', { device: portInfo(port) });
    return ready;
  } catch (error) {
    logEvent('output-open-error', { device: portInfo(port), message: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    updateSelectedOutputLabel();
  }
}

function attachSelectedInput() {
  for (const input of access?.inputs.values() ?? []) {
    if (input.onmidimessage === handleLoopbackMessage) input.onmidimessage = null;
  }
  selectedInput = access?.inputs.get(ui.inputSelect.value) ?? null;
  if (selectedInput) selectedInput.onmidimessage = handleLoopbackMessage;
  updateSelectedOutputLabel();
  logEvent(selectedInput ? 'loopback-input-selected' : 'loopback-input-cleared', {
    device: selectedInput ? portInfo(selectedInput) : null,
  });
}

function handleLoopbackMessage(event) {
  const bytes = Array.from(event.data ?? []);
  const packet = {
    inputDeviceId: selectedInput?.id ?? null,
    inputDevice: selectedInput ? portInfo(selectedInput) : null,
    bytes,
    timestampMs: Number.isFinite(event.timeStamp) ? event.timeStamp : nowMs(),
    receivedAtPerfMs: nowMs(),
  };
  observedPackets.push(packet);
  if (observedPackets.length > MAX_CAPTURED_EVENTS) observedPackets.shift();
  logEvent('loopback-midi-in', packet);
}

async function requestMidiAccess() {
  updateSecureContext();
  if (typeof navigator.requestMIDIAccess !== 'function') {
    permissionState = 'unsupported';
    access = null;
    renderPorts();
    updatePermissionLabel('Web MIDI API is unavailable in this browser.');
    logEvent('midi-access-unsupported');
    return;
  }
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    permissionState = 'ready';
    access.onstatechange = handlePortStateChange;
    renderPorts();
    updatePermissionLabel();
    logEvent('midi-access-granted', {
      inputCount: access.inputs.size,
      outputCount: access.outputs.size,
    });
    if (selectedOutput) {
      await openOutputPort(selectedOutput);
      await recoverPortAfterReconnect(selectedOutput);
    }
    await inspectBrowserPermission();
  } catch (error) {
    permissionState = error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'denied' : 'error';
    access = null;
    selectedOutput = null;
    selectedInput = null;
    renderPorts();
    updatePermissionLabel(error instanceof Error ? error.message : String(error));
    logEvent('midi-access-rejected', {
      name: error?.name ?? 'Error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function inspectBrowserPermission() {
  try {
    const result = await navigator.permissions?.query({ name: 'midi' });
    if (result) {
      logEvent('browser-permissions-api', { midiPermission: result.state });
      result.onchange = () => logEvent('browser-permission-change', { midiPermission: result.state });
    }
  } catch {
    logEvent('browser-permissions-api-unavailable', { note: 'The browser does not expose a queryable MIDI permission descriptor.' });
  }
}

function getRouteState(portId, create) {
  let state = activeNotesByOutput.get(portId);
  if (!state && create) {
    state = new Map();
    activeNotesByOutput.set(portId, state);
  }
  return state ?? new Map();
}

function clearNoteTimers(note) {
  if (note.retryTimeoutId !== null && note.retryTimeoutId !== undefined) {
    window.clearTimeout(note.retryTimeoutId);
    note.retryTimeoutId = null;
  }
  if (note.cleanupTimeoutId !== null && note.cleanupTimeoutId !== undefined) {
    window.clearTimeout(note.cleanupTimeoutId);
    note.cleanupTimeoutId = null;
  }
}

function unresolvedNoteDetails(note) {
  return {
    noteId: note.id,
    midiChannel: note.midiChannel,
    pitch: note.pitch,
    velocity: note.velocity,
    noteOffState: note.noteOffState,
    intendedOnTimeMs: note.onTime,
    intendedOffTimeMs: note.offTime,
    scheduledOffTimeMs: note.scheduledOffTime ?? null,
    noteOffAttempts: note.noteOffAttempts ?? 0,
    retryLimit: MAX_NOTE_OFF_SEND_ATTEMPTS,
  };
}

function buildUnresolvedRecoverySnapshot() {
  const pendingNoteReleases = [];
  for (const [outputDeviceId, notes] of activeNotesByOutput) {
    for (const note of notes.values()) {
      if (note.noteOffState !== 'pending') continue;
      pendingNoteReleases.push({ outputDeviceId, ...unresolvedNoteDetails(note) });
    }
  }
  pendingNoteReleases.sort((a, b) =>
    a.outputDeviceId.localeCompare(b.outputDeviceId) ||
    a.midiChannel - b.midiChannel ||
    a.pitch - b.pitch,
  );

  const reconnectRecoveries = [...recoveryByOutput.entries()]
    .map(([outputDeviceId, recovery]) => ({
      outputDeviceId,
      pendingVoices: [...recovery.notes.values()].map(unresolvedNoteDetails)
        .sort((a, b) => a.midiChannel - b.midiChannel || a.pitch - b.pitch),
      pendingSustainChannels: [...recovery.sustainChannels].sort((a, b) => a - b),
      latestQueuedEventPerfMs: recovery.latestQueuedEventPerfMs,
    }))
    .sort((a, b) => a.outputDeviceId.localeCompare(b.outputDeviceId));
  return { pendingNoteReleases, reconnectRecoveries };
}

function getSustainState(portId, create) {
  let state = sustainChannelsByOutput.get(portId);
  if (!state && create) {
    state = new Set();
    sustainChannelsByOutput.set(portId, state);
  }
  return state ?? new Set();
}

function markScheduledEventsCancelled(portId, clearedAtPerfMs) {
  const cancelled = [];
  for (const packet of expectedPackets) {
    if (
      packet.outputDeviceId === portId &&
      packet.cancelledAtPerfMs === null &&
      packet.timestampMs !== null &&
      packet.timestampMs > clearedAtPerfMs
    ) {
      packet.cancelledAtPerfMs = clearedAtPerfMs;
      cancelled.push(packet.packetId);
    }
  }
  return cancelled;
}

function clearOutputQueue(port, reason) {
  const clearedAtPerfMs = nowMs();
  try {
    if (typeof port.clear === 'function') {
      port.clear();
      latestQueuedEventPerfMsByOutput.delete(port.id);
      const cancelledExpectedPacketIds = markScheduledEventsCancelled(port.id, clearedAtPerfMs);
      logEvent('output-queue-cleared', {
        reason,
        device: portInfo(port),
        clearedAtPerfMs,
        cancelledExpectedPacketIds,
      });
      return true;
    }
    logEvent('output-queue-clear-unavailable', { reason, device: portInfo(port), clearedAtPerfMs });
  } catch (error) {
    logEvent('output-queue-clear-error', {
      reason,
      device: portInfo(port),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

function handlePortDisconnected(port) {
  const active = [...getRouteState(port.id, false).values()];
  const sustainChannels = [...getSustainState(port.id, false)];
  const now = nowMs();
  const uncancelledQueuedPackets = expectedPackets.filter(packet => packet.outputDeviceId === port.id && packet.cancelledAtPerfMs === null);
  const latestQueuedEventPerfMs = Math.max(
    now,
    latestQueuedEventPerfMsByOutput.get(port.id) ?? now,
    ...uncancelledQueuedPackets.map(packet => packet.timestampMs ?? now),
    ...active.map(note => note.offTime),
  );
  const pendingSustainChannels = uncancelledQueuedPackets
    .filter(packet => packet.timestampMs !== null && packet.timestampMs > now && (packet.bytes[0] & 0xf0) === 0xb0 && packet.bytes[1] === 64)
    .map(packet => (packet.bytes[0] & 0x0f) + 1);
  const existing = recoveryByOutput.get(port.id) ?? {
    notes: new Map(),
    sustainChannels: new Set(),
    latestQueuedEventPerfMs: now,
    generation: 0,
  };
  existing.generation = (existing.generation ?? 0) + 1;
  existing.latestQueuedEventPerfMs = Math.max(existing.latestQueuedEventPerfMs, latestQueuedEventPerfMs);
  for (const note of active) {
    const key = `${note.midiChannel}:${note.pitch}`;
    const previous = existing.notes.get(key);
    // Several diagnostic notes can contribute the same physical voice. Keep
    // the latest accepted onset so reconnect cleanup can never precede a later
    // queued unison attack, regardless of submission order.
    if (!previous || note.onTime >= previous.onTime) existing.notes.set(key, note);
  }
  for (const channel of sustainChannels) existing.sustainChannels.add(channel);
  for (const [channel, transition] of sustainTransitionsByOutput.get(port.id) ?? []) {
    if (transition.value >= 64 || transition.timestampMs > now) existing.sustainChannels.add(channel);
  }
  for (const channel of pendingSustainChannels) existing.sustainChannels.add(channel);
  if (existing.notes.size > 0 || existing.sustainChannels.size > 0 || latestQueuedEventPerfMs > now) {
    recoveryByOutput.set(port.id, existing);
  }
  const queueCleared = clearOutputQueue(port, 'disconnect');
  updateSelectedOutputLabel();
  logEvent('output-disconnected', {
    device: portInfo(port),
    retainedReceiverStatePossible: true,
    queueCleared,
    recoveryVoices: [...existing.notes.values()].map(note => ({ midiChannel: note.midiChannel, pitch: note.pitch })),
    recoverySustainChannels: [...existing.sustainChannels].sort((a, b) => a - b),
    latestQueuedEventPerfMs: existing.latestQueuedEventPerfMs,
  });
}

async function recoverPortAfterReconnect(port) {
  const inFlight = reconnectRecoveryPromisesByOutput.get(port.id);
  if (inFlight) return inFlight;
  const recovery = recoveryByOutput.get(port.id);
  if (!recovery) return;
  const generation = recovery.generation ?? 0;
  const task = performPortReconnectRecovery(port, generation);
  reconnectRecoveryPromisesByOutput.set(port.id, task);
  try {
    await task;
  } finally {
    if (reconnectRecoveryPromisesByOutput.get(port.id) === task) {
      reconnectRecoveryPromisesByOutput.delete(port.id);
    }
  }
  const latestRecovery = recoveryByOutput.get(port.id);
  if (
    latestRecovery &&
    (latestRecovery !== recovery || latestRecovery.generation !== generation) &&
    port.state === 'connected'
  ) {
    // If a rapid unplug/replug invalidated this task while it awaited a safe
    // timestamp, retry once from the new generation rather than settling stale
    // recovery ownership. Further generation changes are coalesced identically.
    await recoverPortAfterReconnect(port);
  }
}

async function performPortReconnectRecovery(port, generation) {
  const recovery = recoveryByOutput.get(port.id);
  if (!recovery || recovery.generation !== generation) return;
  if (!(await openOutputPort(port))) return;
  if (recoveryByOutput.get(port.id) !== recovery || recovery.generation !== generation) return;
  const queueCleared = clearOutputQueue(port, 'reconnect-recovery');
  const latestOnTime = Math.max(-Infinity, ...[...recovery.notes.values()].map(note => note.onTime));
  const deadline = queueCleared
    ? Math.max(nowMs(), latestOnTime + 1)
    : Math.max(nowMs(), recovery.latestQueuedEventPerfMs + 1, latestOnTime + 1);
  while (nowMs() < deadline) await new Promise(resolve => setTimeout(resolve, deadline - nowMs()));

  const currentRecovery = recoveryByOutput.get(port.id);
  if (!currentRecovery || currentRecovery !== recovery || currentRecovery.generation !== generation) return;
  if (port.state !== 'connected' || (port.connection !== undefined && port.connection !== 'open')) return;
  logEvent('reconnect-recovery-start', {
    device: portInfo(port),
    queueCleared,
    noteOffCount: currentRecovery.notes.size,
    sustainChannels: [...currentRecovery.sustainChannels].sort((a, b) => a - b),
  });
  let complete = true;
  for (const channel of [...currentRecovery.sustainChannels].sort((a, b) => a - b)) {
    const sent = sendPacket(port, [0xb0 | (channel - 1), 64, 0], nowMs(), 'recovery-cc64-up');
    complete = sent && complete;
    if (sent) {
      currentRecovery.sustainChannels.delete(channel);
      getSustainState(port.id, false).delete(channel);
      const transitions = sustainTransitionsByOutput.get(port.id);
      transitions?.delete(channel);
      if (transitions?.size === 0) sustainTransitionsByOutput.delete(port.id);
    }
  }

  const notes = [...currentRecovery.notes.entries()].sort(([, a], [, b]) => a.midiChannel - b.midiChannel || a.pitch - b.pitch);
  const queuedNoteOffs = new Map();
  let latestRecoveryOffTime = -Infinity;
  for (const [key, note] of notes) {
    const releaseTime = Math.max(nowMs(), note.onTime + 1);
    const sent = sendPacket(port, [0x80 | (note.midiChannel - 1), note.pitch, 0], releaseTime, 'recovery-note-off');
    complete = sent && complete;
    if (sent) {
      queuedNoteOffs.set(key, { onTime: note.onTime, releaseTime });
      latestRecoveryOffTime = Math.max(latestRecoveryOffTime, releaseTime);
    }
  }

  // A send accepted with a future timestamp is queued, not yet a delivered
  // release. Keep route ownership and the recovery gate until that safe Note
  // Off time has passed; a second disconnect during the wait retains the same
  // (output, channel, pitch) cleanup state for the next reconnect.
  if (latestRecoveryOffTime > nowMs()) {
    const releaseDeadline = latestRecoveryOffTime + 1;
    while (nowMs() < releaseDeadline) await new Promise(resolve => setTimeout(resolve, releaseDeadline - nowMs()));
  }
  const settledRecovery = recoveryByOutput.get(port.id);
  if (
    !settledRecovery ||
    settledRecovery !== recovery ||
    settledRecovery.generation !== generation ||
    port.state !== 'connected' ||
    (port.connection !== undefined && port.connection !== 'open')
  ) return;
  for (const [key, sentRelease] of queuedNoteOffs) {
    const stillOwned = settledRecovery.notes.get(key);
    if (stillOwned && stillOwned.onTime <= sentRelease.onTime) settledRecovery.notes.delete(key);
  }
  complete = complete && settledRecovery.notes.size === 0 && settledRecovery.sustainChannels.size === 0;

  if (complete) {
    recoveryByOutput.delete(port.id);
    for (const note of getRouteState(port.id, false).values()) clearNoteTimers(note);
    activeNotesByOutput.delete(port.id);
    sustainChannelsByOutput.delete(port.id);
    sustainTransitionsByOutput.delete(port.id);
    latestQueuedEventPerfMsByOutput.delete(port.id);
    updateSelectedOutputLabel();
    logEvent('reconnect-recovery-complete', { device: portInfo(port) });
  } else {
    updateSelectedOutputLabel();
    logEvent('reconnect-recovery-incomplete', { device: portInfo(port), complete, pendingVoices: settledRecovery.notes.size, pendingSustainChannels: [...settledRecovery.sustainChannels] });
  }
}

function handlePortStateChange(event) {
  const port = event?.port;
  if (!port) return;
  logEvent('device-state-change', { device: portInfo(port) });
  renderPorts();
  if (port.type === 'output' && port.state === 'disconnected') handlePortDisconnected(port);
  if (port.type === 'output' && port.state === 'connected') void recoverPortAfterReconnect(port);
}

function sendPacket(port, bytes, timestampMs, kind) {
  const recoveryPending = Boolean(port && recoveryByOutput.has(port.id) && !kind.startsWith('recovery-'));
  const noteReleasePending = Boolean(
    port &&
    hasPendingNoteRelease(port.id) &&
    kind !== 'test-note-off' &&
    kind !== 'test-note-off-retry' &&
    !kind.startsWith('recovery-'),
  );
  if (!port || typeof port.send !== 'function' || port.state !== 'connected' || recoveryPending || noteReleasePending) {
    logEvent('output-send-failed', {
      kind,
      device: portInfo(port),
      bytes,
      timestampMs,
      message: recoveryPending
        ? 'Reconnect cleanup is pending for this output.'
        : noteReleasePending
          ? 'A previously accepted test Note On is awaiting its Note Off.'
          : 'Selected output is not connected.',
    });
    return false;
  }
  try {
    port.send(bytes, timestampMs);
    const queuedAtPerfMs = Number.isFinite(timestampMs) ? timestampMs : nowMs();
    latestQueuedEventPerfMsByOutput.set(
      port.id,
      Math.max(latestQueuedEventPerfMsByOutput.get(port.id) ?? -Infinity, queuedAtPerfMs),
    );
    const packet = {
      packetId: nextPacketId++,
      outputDeviceId: port.id,
      outputDevice: portInfo(port),
      bytes: [...bytes],
      timestampMs,
      sentAtPerfMs: nowMs(),
      cancelledAtPerfMs: null,
      kind,
    };
    expectedPackets.push(packet);
    if (expectedPackets.length > MAX_CAPTURED_EVENTS) expectedPackets.shift();
    logEvent('output-send', packet);
    return true;
  } catch (error) {
    logEvent('output-send-failed', {
      kind,
      device: portInfo(port),
      bytes,
      timestampMs,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function selectedReadyOutput() {
  const port = access?.outputs.get(ui.outputSelect.value) ?? null;
  selectedOutput = port;
  updateSelectedOutputLabel();
  if (!port || recoveryByOutput.has(port.id) || hasPendingNoteRelease(port.id) || !(await openOutputPort(port))) return null;
  return port;
}

function scheduleNoteCleanup(portId, key, note, releasePerfMs) {
  if (note.cleanupTimeoutId !== null && note.cleanupTimeoutId !== undefined) {
    window.clearTimeout(note.cleanupTimeoutId);
  }
  const settle = () => {
    note.cleanupTimeoutId = null;
    const remainingMs = releasePerfMs + NOTE_OFF_SETTLE_MS - nowMs();
    if (remainingMs > 0) {
      note.cleanupTimeoutId = window.setTimeout(settle, remainingMs);
      return;
    }
    const route = getRouteState(portId, false);
    if (route.get(key) !== note || note.noteOffState !== 'scheduled' || recoveryByOutput.has(portId)) return;
    const port = access?.outputs.get(portId) ?? (selectedOutput?.id === portId ? selectedOutput : null);
    if (!port || port.state !== 'connected' || (port.connection !== undefined && port.connection !== 'open')) {
      logEvent('test-note-release-awaiting-reconnect', {
        outputDeviceId: portId,
        midiChannel: note.midiChannel,
        pitch: note.pitch,
        intendedOnTimeMs: note.onTime,
        intendedOffTimeMs: note.offTime,
        scheduledOffTimeMs: note.scheduledOffTime ?? null,
      });
      updateSelectedOutputLabel();
      return;
    }
    route.delete(key);
    if (route.size === 0) activeNotesByOutput.delete(portId);
    updateSelectedOutputLabel();
    logEvent('test-note-release-settled', {
      device: portInfo(port),
      midiChannel: note.midiChannel,
      pitch: note.pitch,
      intendedOffTimeMs: note.offTime,
      scheduledOffTimeMs: note.scheduledOffTime ?? releasePerfMs,
    });
  };
  note.cleanupTimeoutId = window.setTimeout(
    settle,
    Math.max(0, releasePerfMs + NOTE_OFF_SETTLE_MS - nowMs()),
  );
}

function scheduleNoteOffRetry(portId, key, note, delayMs) {
  if (note.retryTimeoutId !== null && note.retryTimeoutId !== undefined) {
    window.clearTimeout(note.retryTimeoutId);
  }
  note.retryTimeoutId = window.setTimeout(() => {
    note.retryTimeoutId = null;
    void retryPendingNoteOff(portId, key, note);
  }, Math.max(0, delayMs));
}

function logNoteOffRetryExhausted(portId, note) {
  logEvent('test-note-off-retry-exhausted', {
    outputDeviceId: portId,
    midiChannel: note.midiChannel,
    pitch: note.pitch,
    intendedOnTimeMs: note.onTime,
    intendedOffTimeMs: note.offTime,
    attempts: note.noteOffAttempts,
    retryLimit: MAX_NOTE_OFF_SEND_ATTEMPTS,
    unresolved: true,
  });
  updateSelectedOutputLabel();
}

async function retryPendingNoteOff(portId, key, note) {
  const route = getRouteState(portId, false);
  if (route.get(key) !== note || note.noteOffState !== 'pending' || recoveryByOutput.has(portId)) return;

  const safeNotBefore = Math.max(note.offTime, note.onTime + 1);
  if (nowMs() < safeNotBefore + 1) {
    scheduleNoteOffRetry(portId, key, note, safeNotBefore + 1 - nowMs());
    return;
  }
  const port = access?.outputs.get(portId) ?? (selectedOutput?.id === portId ? selectedOutput : null);
  if (!port || port.state !== 'connected') {
    logEvent('test-note-off-deferred-to-reconnect', {
      outputDeviceId: portId,
      midiChannel: note.midiChannel,
      pitch: note.pitch,
      intendedOnTimeMs: note.onTime,
      intendedOffTimeMs: note.offTime,
      attempts: note.noteOffAttempts,
    });
    updateSelectedOutputLabel();
    return;
  }
  if (note.noteOffAttempts >= MAX_NOTE_OFF_SEND_ATTEMPTS) {
    logNoteOffRetryExhausted(portId, note);
    return;
  }

  note.noteOffAttempts += 1;
  const ready = await openOutputPort(port);
  if (!ready) {
    logEvent('test-note-off-retry-failed', {
      outputDeviceId: portId,
      midiChannel: note.midiChannel,
      pitch: note.pitch,
      attempt: note.noteOffAttempts,
      message: 'The same selected MIDI output could not be opened for its pending Note Off.',
    });
  } else if (route.get(key) === note && !recoveryByOutput.has(portId)) {
    const releasePerfMs = Math.max(nowMs(), safeNotBefore);
    const sent = sendPacket(port, [0x80 | (note.midiChannel - 1), note.pitch, 0], releasePerfMs, 'test-note-off-retry');
    if (sent) {
      note.noteOffState = 'scheduled';
      note.scheduledOffTime = releasePerfMs;
      scheduleNoteCleanup(portId, key, note, releasePerfMs);
      updateSelectedOutputLabel();
      logEvent('test-note-off-retry-scheduled', {
        device: portInfo(port),
        midiChannel: note.midiChannel,
        pitch: note.pitch,
        intendedOnTimeMs: note.onTime,
        intendedOffTimeMs: note.offTime,
        scheduledOffTimeMs: releasePerfMs,
        attempts: note.noteOffAttempts,
      });
      return;
    }
    logEvent('test-note-off-retry-failed', {
      outputDeviceId: portId,
      midiChannel: note.midiChannel,
      pitch: note.pitch,
      attempt: note.noteOffAttempts,
      message: 'The same output rejected the pending Note Off.',
    });
  }

  if (route.get(key) === note && note.noteOffState === 'pending') {
    if (note.noteOffAttempts < MAX_NOTE_OFF_SEND_ATTEMPTS) {
      scheduleNoteOffRetry(portId, key, note, NOTE_OFF_RETRY_DELAY_MS * note.noteOffAttempts);
    } else {
      logNoteOffRetryExhausted(portId, note);
    }
  }
  updateSelectedOutputLabel();
}

async function sendTestNote() {
  const port = await selectedReadyOutput();
  if (!port) return;
  const channel = safeNumber(ui.channelSelect, 1, 16, 1);
  const pitch = safeNumber(ui.pitch, 0, 127, 60);
  const velocity = safeNumber(ui.velocity, 1, 127, 96);
  const gateMs = safeNumber(ui.gate, 20, 10000, 500);
  const onTime = nowMs() + 80;
  const offTime = onTime + gateMs;
  const id = `${channel}:${pitch}:${nextEventId}`;
  const key = `${channel}:${pitch}:${id}`;
  const note = {
    id,
    midiChannel: channel,
    pitch,
    velocity,
    onTime,
    offTime,
    scheduledOffTime: null,
    noteOffState: 'pending',
    noteOffAttempts: 0,
    retryTimeoutId: null,
    cleanupTimeoutId: null,
  };
  const onSent = sendPacket(port, [0x90 | (channel - 1), pitch, velocity], onTime, 'test-note-on');
  if (!onSent) {
    logEvent('test-note-not-scheduled', {
      device: portInfo(port),
      midiChannel: channel,
      pitch,
      velocity,
      noteOnAccepted: false,
      noteOffAccepted: false,
      schedulingStatus: 'failed',
      intendedOnTimeMs: onTime,
      intendedOffTimeMs: offTime,
    });
    return;
  }

  // Own the voice immediately after the output accepts Note On. In particular,
  // a later synchronous Note Off exception must not erase recovery ownership.
  getRouteState(port.id, true).set(key, note);
  note.noteOffAttempts = 1;
  const offSent = sendPacket(port, [0x80 | (channel - 1), pitch, 0], offTime, 'test-note-off');
  if (offSent) {
    note.noteOffState = 'scheduled';
    note.scheduledOffTime = offTime;
    scheduleNoteCleanup(port.id, key, note, offTime);
    updateSelectedOutputLabel();
    logEvent('test-note-scheduled', {
      device: portInfo(port),
      midiChannel: channel,
      pitch,
      velocity,
      gateMs,
      onTimeMs: onTime,
      offTimeMs: offTime,
      noteOnAccepted: true,
      noteOffAccepted: true,
      schedulingStatus: 'complete',
    });
    return;
  }

  updateSelectedOutputLabel();
  logEvent('test-note-partial-schedule', {
    device: portInfo(port),
    midiChannel: channel,
    pitch,
    velocity,
    gateMs,
    noteOnAccepted: true,
    noteOffAccepted: false,
    schedulingStatus: 'partial',
    intendedOnTimeMs: onTime,
    intendedOffTimeMs: offTime,
    noteOffAttempts: note.noteOffAttempts,
    retryLimit: MAX_NOTE_OFF_SEND_ATTEMPTS,
    unresolved: true,
  });
  const safeNotBefore = Math.max(offTime, onTime + 1);
  scheduleNoteOffRetry(port.id, key, note, Math.max(0, safeNotBefore + 1 - nowMs()));
}

async function sendControlChange(number, value, label) {
  const port = await selectedReadyOutput();
  if (!port) return;
  const channel = safeNumber(ui.channelSelect, 1, 16, 1);
  const cc = safeNumber({ value: String(number) }, 0, 127, 64);
  const ccValue = safeNumber({ value: String(value) }, 0, 127, 0);
  const time = nowMs() + 20;
  const sent = sendPacket(port, [0xb0 | (channel - 1), cc, ccValue], time, label);
  if (sent && cc === 64) {
    const sustain = getSustainState(port.id, true);
    const transitions = sustainTransitionsByOutput.get(port.id) ?? new Map();
    transitions.set(channel, { timestampMs: time, value: ccValue });
    sustainTransitionsByOutput.set(port.id, transitions);
    if (ccValue >= 64) sustain.add(channel);
    else sustain.delete(channel);
  }
}

async function sendSelectedCc() {
  await sendControlChange(
    safeNumber(ui.ccNumber, 0, 127, 64),
    safeNumber(ui.ccValue, 0, 127, 127),
    'test-control-change',
  );
}

async function panicSelectedRoute() {
  const port = await selectedReadyOutput();
  if (!port) return;
  const channel = safeNumber(ui.channelSelect, 1, 16, 1);
  if (!window.confirm(`Send Note Offs, CC64=0 and CC123=0 to ${port.name || port.id}, MIDI channel ${channel}? CC123 can silence all voices on that synth channel.`)) return;
  const active = [...getRouteState(port.id, false).values()].filter(note => note.midiChannel === channel);
  for (const note of active) sendPacket(port, [0x80 | (channel - 1), note.pitch, 0], nowMs(), 'panic-note-off');
  const sustainUpTime = nowMs();
  if (sendPacket(port, [0xb0 | (channel - 1), 64, 0], sustainUpTime, 'panic-cc64-up')) {
    const transitions = sustainTransitionsByOutput.get(port.id) ?? new Map();
    transitions.set(channel, { timestampMs: sustainUpTime, value: 0 });
    sustainTransitionsByOutput.set(port.id, transitions);
  }
  sendPacket(port, [0xb0 | (channel - 1), 123, 0], nowMs(), 'panic-cc123-all-notes-off');
  for (const [key, note] of getRouteState(port.id, false)) {
    if (note.midiChannel === channel) getRouteState(port.id, false).delete(key);
  }
  getSustainState(port.id, false).delete(channel);
  logEvent('panic-route-complete', { device: portInfo(port), midiChannel: channel, noteOffCount: active.length });
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameMessageOtherChannel(a, b) {
  return a.length === 3 && b.length === 3 && (a[0] & 0xf0) === (b[0] & 0xf0) && a[1] === b[1] && a[2] === b[2] && (a[0] & 0x0f) !== (b[0] & 0x0f);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function compareLoopback() {
  if (!selectedOutput || !selectedInput) {
    ui.summary.textContent = 'Select one output and one loopback input before comparing.';
    return;
  }
  const expected = expectedPackets.filter(packet => packet.outputDeviceId === selectedOutput.id && packet.cancelledAtPerfMs === null);
  const received = observedPackets.filter(packet => packet.inputDeviceId === selectedInput.id);
  const matchedObserved = new Set();
  const exactMatches = [];
  const missing = [];
  for (const sent of expected) {
    const index = received.findIndex((packet, packetIndex) => !matchedObserved.has(packetIndex) && sameBytes(sent.bytes, packet.bytes));
    if (index < 0) missing.push(sent);
    else {
      matchedObserved.add(index);
      exactMatches.push({ sent, received: received[index] });
    }
  }
  const extra = received.filter((_, index) => !matchedObserved.has(index));
  const misrouted = extra.filter(packet => missing.some(sent => sameMessageOtherChannel(sent.bytes, packet.bytes)));
  const matchedDeltas = exactMatches
    .filter(pair => Number.isFinite(pair.received.timestampMs) && Number.isFinite(pair.sent.timestampMs))
    .map(pair => pair.received.timestampMs - pair.sent.timestampMs);
  const duplicateCount = extra.filter(packet => expected.some(sent => sameBytes(sent.bytes, packet.bytes))).length;
  const summary = [
    `Output: ${selectedOutput.name || 'Unnamed'} [${selectedOutput.id}]`,
    `Input: ${selectedInput.name || 'Unnamed'} [${selectedInput.id}]`,
    `Non-cancelled expected sends: ${expected.length}; loopback received: ${received.length}`,
    `Exact byte matches: ${exactMatches.length}; missing: ${missing.length}; extra: ${extra.length}; duplicates: ${duplicateCount}; wrong-channel candidates: ${misrouted.length}`,
    `Requested-to-observed delta (ms): median ${percentile(matchedDeltas, 0.5)?.toFixed(3) ?? 'n/a'}, p95 ${percentile(matchedDeltas, 0.95)?.toFixed(3) ?? 'n/a'}, max ${matchedDeltas.length ? Math.max(...matchedDeltas).toFixed(3) : 'n/a'}`,
    `Missing: ${missing.map(packet => `${packet.kind} ${bytesText(packet.bytes)}`).join(', ') || 'none'}`,
    `Extra: ${extra.map(packet => bytesText(packet.bytes)).join(', ') || 'none'}`,
    'Timing is reported, not judged against an arbitrary threshold. Compare with a calibrated loopback baseline and the interface/device specification.',
  ].join('\n');
  ui.summary.textContent = summary;
  logEvent('loopback-comparison', {
    output: portInfo(selectedOutput),
    input: portInfo(selectedInput),
    expectedCount: expected.length,
    receivedCount: received.length,
    exactMatches: exactMatches.length,
    missing: missing.length,
    extra: extra.length,
    duplicates: duplicateCount,
    wrongChannelCandidates: misrouted.length,
    matchedTimestampDeltasMs: matchedDeltas,
  });
}

function downloadBlob(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadJson() {
  const report = {
    schema: 'apex-studio-external-midi-diagnostic/v1',
    capturedAtUtc: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      secureContext: Boolean(window.isSecureContext),
      permissionState,
    },
    selectedOutput: selectedOutput ? portInfo(selectedOutput) : null,
    selectedInput: selectedInput ? portInfo(selectedInput) : null,
    unresolvedRecovery: buildUnresolvedRecoverySnapshot(),
    events,
    expectedPackets,
    observedLoopbackPackets: observedPackets,
    loopbackSummary: ui.summary.textContent,
  };
  downloadBlob(`apex-midi-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(report, null, 2), 'application/json');
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv() {
  const columns = ['eventId', 'utc', 'perfTimeMs', 'type', 'permissionState', 'outputId', 'outputName', 'inputId', 'inputName', 'channel', 'bytes', 'timestampMs', 'detail'];
  const rows = events.map(event => [
    event.eventId,
    event.utc,
    event.perfTimeMs,
    event.type,
    event.permissionState,
    event.output?.id,
    event.output?.name,
    event.input?.id,
    event.input?.name,
    event.channel,
    event.bytes,
    event.timestampMs,
    Object.fromEntries(Object.entries(event).filter(([key]) => !['eventId', 'utc', 'perfTimeMs', 'type', 'permissionState', 'output', 'input', 'channel', 'bytes', 'timestampMs'].includes(key))),
  ]);
  const selectedOutputInfo = selectedOutput ? portInfo(selectedOutput) : null;
  const selectedInputInfo = selectedInput ? portInfo(selectedInput) : null;
  rows.push([
    '',
    new Date().toISOString(),
    nowMs(),
    'unresolved-recovery-snapshot',
    permissionState,
    selectedOutputInfo?.id,
    selectedOutputInfo?.name,
    selectedInputInfo?.id,
    selectedInputInfo?.name,
    Number(ui.channelSelect.value) || null,
    null,
    null,
    { unresolvedRecovery: buildUnresolvedRecoverySnapshot() },
  ]);
  const content = [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(`apex-midi-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, content, 'text/csv;charset=utf-8');
}

function clearLog() {
  events.length = 0;
  expectedPackets.length = 0;
  observedPackets.length = 0;
  ui.log.replaceChildren();
  ui.summary.textContent = 'Log and loopback comparison cleared.';
  ui.downloadJson.disabled = true;
  ui.downloadCsv.disabled = true;
  logEvent('log-cleared');
}

ui.request.addEventListener('click', () => void requestMidiAccess());
ui.outputSelect.addEventListener('change', async () => {
  selectedOutput = access?.outputs.get(ui.outputSelect.value) ?? null;
  updateSelectedOutputLabel();
  logEvent(selectedOutput ? 'output-selected' : 'output-selection-cleared', { device: selectedOutput ? portInfo(selectedOutput) : null });
  if (selectedOutput) await openOutputPort(selectedOutput);
});
ui.inputSelect.addEventListener('change', attachSelectedInput);
ui.sendNote.addEventListener('click', () => void sendTestNote());
ui.sendCc.addEventListener('click', () => void sendSelectedCc());
ui.sustainDown.addEventListener('click', () => void sendControlChange(64, 127, 'cc64-sustain-down'));
ui.sustainUp.addEventListener('click', () => void sendControlChange(64, 0, 'cc64-sustain-up'));
ui.panic.addEventListener('click', () => void panicSelectedRoute());
ui.compare.addEventListener('click', compareLoopback);
$('clear-log-btn').addEventListener('click', clearLog);
ui.downloadJson.addEventListener('click', downloadJson);
ui.downloadCsv.addEventListener('click', downloadCsv);

updateSecureContext();
updatePermissionLabel();
updateSelectedOutputLabel();
logEvent('diagnostic-page-ready', {
  note: 'Standalone diagnostic; does not call production real-time playback.',
  webMidiSupported: typeof navigator.requestMIDIAccess === 'function',
});
