// GitHub truncates a check annotation message at 4096 characters, and it does so
// by cutting the string - which lands mid-JSON and makes the evidence unreadable.
// That is how the failing run's per-block decomposition was lost twice during the
// cold-start deadline investigation. So build the message by giving things up in a
// defined order of usefulness, keeping the result a whole parseable object:
//
//   1. auxiliary fields, in the caller's order of least value;
//   2. the ordinary block list, halved repeatedly down to one row;
//   3. the preserved list, halved down to one row - never dropped outright, because
//      a single row still names the sequence the real-time guard gave up on;
//   4. only then a hard cut, reported honestly via `truncated`.
export const ANNOTATION_MESSAGE_LIMIT = 4096;

const DEFAULT_SHED = ['mainEventLoopWorstStalls', 'mainRecordedSequences',
  'deadlineMissEvents', 'helperStartup'];

export function buildCiAnnotation(title, payload, options = {}) {
  const cap = options.cap ?? ANNOTATION_MESSAGE_LIMIT - 200;
  const shed = options.shed ?? DEFAULT_SHED;
  const preserve = options.preserve ?? 'blocksAroundMiss';
  // Fields whose LENGTH is itself the result. A 60-repetition run list halved to 30
  // silently claimed to be the full set, so any reduction of these is recorded in
  // the body rather than left for the reader to guess at.
  const keepCounts = new Set(options.keepCounts ?? []);
  // Fields that ARE the result rather than a window onto data. Halving one of these
  // does not reduce its detail, it makes it false: `failingRepetitions` cut from
  // [4, 14, 29, 60] to [4] still reads as "one repetition failed", which is exactly
  // what the 60-repetition diagnostic reported at `3c3817d` for a run that failed
  // four times. keepCounts only records a reduction; these are held out of the
  // halving pass altogether. Their length is still recorded, so if the hard cap ever
  // does bite, the body says so instead of quietly claiming a shorter list.
  const exact = new Set(options.exact ?? []);
  const fullCounts = {};
  for (const field of [...keepCounts, ...exact]) {
    if (Array.isArray(payload[field])) fullCounts[field] = payload[field].length;
  }
  const encode = text => String(text)
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const size = body => encode(JSON.stringify(body)).length;

  let body = { ...payload };
  for (const field of shed) {
    if (size(body) <= cap) break;
    if (body[field] === undefined) continue;
    body = { ...body, [field]: undefined };
  }
  // Halve rather than drop: half a window is still evidence, an empty one is not.
  const halve = field => {
    const rows = body[field];
    if (!Array.isArray(rows) || rows.length <= 1) return false;
    body = { ...body, [field]: rows.slice(0, Math.max(1, Math.floor(rows.length / 2))) };
    return true;
  };
  const secondary = Object.keys(body)
    .filter(key => key !== preserve && !exact.has(key)
      && Array.isArray(body[key]) && body[key].length > 1);
  while (size(body) > cap && secondary.some(halve)) { /* keep halving */ }
  while (size(body) > cap && halve(preserve)) { /* keep halving */ }

  for (const [field, full] of Object.entries(fullCounts)) {
    const kept = Array.isArray(body[field]) ? body[field].length : 0;
    if (kept < full) {
      body = { ...body, [`${field}ReducedFrom`]: full, [`${field}Kept`]: kept };
    }
  }

  let message = encode(JSON.stringify(body));
  let truncated = false;
  if (message.length > cap) {
    message = message.slice(0, cap);
    truncated = true;
  }
  return { text: `::notice title=${encode(title)}::${message}`, truncated };
}
