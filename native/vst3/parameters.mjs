// Shared validation at the privileged service boundary. No native commands here.
export function validateMetadata(parameters, controllerAvailable) {
  if (typeof controllerAvailable !== 'boolean' || !Array.isArray(parameters) || parameters.length > 4096 ||
    (!controllerAvailable && parameters.length) || JSON.stringify(parameters).length > 4 * 1024 * 1024) throw new Error('Invalid VST3 parameter metadata');
  const ids = new Set();
  for (const p of parameters) {
    if (!p || !Number.isInteger(p.id) || p.id < 0 || p.id > 0xffffffff || ids.has(p.id) ||
      !['name', 'shortTitle', 'units'].every(key => typeof p[key] === 'string' && p[key].length <= 512) ||
      !Number.isInteger(p.flags) || p.flags < 0 || p.flags > 0x7fffffff ||
      !Number.isInteger(p.stepCount) || p.stepCount < 0 || p.stepCount > 0x7fffffff ||
      !Number.isFinite(p.defaultValue) || p.defaultValue < 0 || p.defaultValue > 1 ||
      (p.currentValue !== null && (!Number.isFinite(p.currentValue) || p.currentValue < 0 || p.currentValue > 1))) throw new Error('Invalid VST3 parameter metadata');
    ids.add(p.id);
    if (p.choices !== undefined && (!(p.flags & 8) || p.stepCount < 1 || p.stepCount > 127 ||
      !Array.isArray(p.choices) || p.choices.length !== p.stepCount + 1 || p.choices.some((choice, i) =>
        !choice || choice.value !== i / p.stepCount || typeof choice.label !== 'string' || !choice.label.length || choice.label.length > 512))) throw new Error('Invalid VST3 parameter choices');
  }
  return parameters;
}
export function validateParameterChanges(changes, parameters) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 4096) throw new Error('Invalid VST3 parameter batch');
  const seen = new Set(), metadata = new Map(parameters.map(p => [p.id, p]));
  return changes.map(change => {
    if (!change || typeof change !== 'object' || Object.keys(change).length !== 2 || !Number.isInteger(change.id) || change.id < 0 || change.id > 0xffffffff ||
      !Number.isFinite(change.value) || change.value < 0 || change.value > 1 || seen.has(change.id)) throw new Error('Invalid or duplicate VST3 parameter change');
    const p = metadata.get(change.id);
    if (!p || (p.flags & (2 | 16))) throw new Error('Unknown or read-only VST3 parameter');
    if (p.flags & 32768) throw new Error('Program-change parameters require reinitialization and are not editable in this slice');
    seen.add(change.id);
    return { id: change.id, value: change.value };
  });
}

/** Process-only timed points. Manual/persisted edits keep the strict unique-ID
 * contract above. Per-ID offsets must increase; repeated values are legal. */
export function validateProcessParameters(changes, parameters, frames) {
  if (!Array.isArray(changes) || changes.length > 4096) throw new Error('Invalid VST3 automation batch');
  if (!changes.length) return [];
  if (changes.every(p => p && !Object.hasOwn(p, 'offset'))) return validateParameterChanges(changes, parameters);
  const last = new Map(), metadata = new Map(parameters.map(p => [p.id, p]));
  return changes.map(p => {
    if (!p || Object.keys(p).length !== 3 || !Number.isInteger(p.offset) || p.offset < 0 || p.offset >= frames ||
        p.offset <= (last.get(p.id) ?? -1)) throw new Error('Invalid or unordered VST3 automation offset');
    const info = metadata.get(p.id);
    const [validated] = validateParameterChanges([{ id: p.id, value: p.value }], info ? [info] : []);
    if (!(info.flags & 1) || ((info.flags & 8) && !info.choices?.some(c => c.value === p.value))) throw new Error('VST3 parameter is not automatable');
    last.set(p.id, p.offset);
    return { ...validated, offset: p.offset };
  });
}

export function validateEditorContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      typeof context.projectId !== 'string' || !context.projectId.length || context.projectId.length > 256 ||
      !Number.isSafeInteger(context.trackId) || context.trackId < 0 || context.trackId > 1_000_000 ||
      typeof context.slotId !== 'string' || !context.slotId.length || context.slotId.length > 128 ||
      Object.keys(context).some(key => !['projectId', 'trackId', 'slotId'].includes(key))) {
    throw new Error('Invalid VST3 editor project/slot context');
  }
  return { projectId: context.projectId, trackId: context.trackId, slotId: context.slotId };
}

export function validateEditorEvents(events, parameters, activeEdits = new Set()) {
  if (!Array.isArray(events) || events.length > 4096 || !(activeEdits instanceof Set)) throw new Error('Invalid or oversized VST3 editor event batch');
  const metadata = new Map(parameters.map(parameter => [parameter.id, parameter]));
  const active = activeEdits;
  return events.map(event => {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        !Number.isInteger(event.id) || event.id < 0 || event.id > 0xffffffff) {
      throw new Error('Invalid VST3 editor parameter callback');
    }
    const parameter = metadata.get(event.id);
    if (!parameter || (parameter.flags & (2 | 16))) throw new Error('VST3 editor callback referenced an unknown or read-only ParamID');
    if (event.type === 'begin' && Object.keys(event).length === 2) {
      if (active.has(event.id) || active.size >= 256) throw new Error('Invalid or excessive VST3 beginEdit callback');
      active.add(event.id);
      return { type: 'begin', id: event.id };
    }
    if (event.type === 'perform' && Object.keys(event).length === 3) {
      if (!active.has(event.id) || !Number.isFinite(event.value) || event.value < 0 || event.value > 1) {
        throw new Error('Invalid VST3 performEdit callback');
      }
      return { type: 'perform', id: event.id, value: event.value };
    }
    if (event.type === 'end' && Object.keys(event).length === 2) {
      if (!active.delete(event.id)) throw new Error('Invalid VST3 endEdit callback');
      return { type: 'end', id: event.id };
    }
    throw new Error('Unknown or malformed VST3 editor callback');
  });
}

export function validateEditorParameterSnapshot(values, parameters) {
  if (!Array.isArray(values) || values.length > 4096) throw new Error('Invalid or oversized VST3 editor parameter snapshot');
  const metadata = new Map(parameters.map(parameter => [parameter.id, parameter]));
  const seen = new Set();
  return values.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 ||
        !Number.isInteger(item.id) || item.id < 0 || item.id > 0xffffffff ||
        !Number.isFinite(item.value) || item.value < 0 || item.value > 1 || seen.has(item.id)) {
      throw new Error('Invalid or duplicate VST3 editor parameter snapshot value');
    }
    const parameter = metadata.get(item.id);
    if (!parameter || (parameter.flags & (2 | 16))) throw new Error('VST3 editor snapshot referenced an unknown or read-only ParamID');
    seen.add(item.id);
    return { id: item.id, value: item.value };
  });
}

export function validateEditorActiveEdits(ids, parameters) {
  if (!Array.isArray(ids) || ids.length > 256) throw new Error('Invalid or oversized VST3 editor active-edit set');
  const metadata = new Map(parameters.map(parameter => [parameter.id, parameter]));
  const seen = new Set();
  for (const id of ids) {
    const parameter = metadata.get(id);
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff || seen.has(id) ||
        !parameter || (parameter.flags & (2 | 16))) throw new Error('VST3 editor active-edit set contains an unknown or read-only ParamID');
    seen.add(id);
  }
  return seen;
}

export function validateEditorState(state, classId, parameters) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schema !== 1 ||
      state.classId !== classId || !Array.isArray(state.parameters) || state.parameters.length > 4096 ||
      Object.keys(state).some(key => !['schema', 'classId', 'component', 'controller', 'parameters'].includes(key))) {
    throw new Error('Invalid VST3 editor state; the previously committed project state is retained');
  }
  for (const key of ['component', 'controller']) {
    const value = state[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 2 * 1024 * 1024 ||
        !/^(?:[A-Fa-f0-9]{2})*$/.test(value))) {
      throw new Error(`Invalid or oversized VST3 ${key} state`);
    }
  }
  const metadata = new Map(parameters.map(parameter => [parameter.id, parameter]));
  const seen = new Set();
  const normalizedParameters = state.parameters.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 ||
        !Number.isInteger(item.id) || item.id < 0 || item.id > 0xffffffff ||
        !Number.isFinite(item.value) || item.value < 0 || item.value > 1 || seen.has(item.id)) {
      throw new Error('Invalid or duplicate normalized VST3 editor parameter value');
    }
    const parameter = metadata.get(item.id);
    if (!parameter || (parameter.flags & 2)) throw new Error('VST3 editor state contains an unknown or read-only ParamID');
    seen.add(item.id);
    return { id: item.id, value: item.value };
  });
  const result = { schema: 1, classId, ...(state.component === undefined ? {} : { component: state.component }),
    ...(state.controller === undefined ? {} : { controller: state.controller }), parameters: normalizedParameters };
  if (JSON.stringify(result).length > 4 * 1024 * 1024) throw new Error('VST3 editor state exceeds the 4 MiB project-state limit');
  return result;
}
