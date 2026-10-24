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
