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
    .filter(key => key !== preserve && Array.isArray(body[key]) && body[key].length > 1);
  while (size(body) > cap && secondary.some(halve)) { /* keep halving */ }
  while (size(body) > cap && halve(preserve)) { /* keep halving */ }

  let message = encode(JSON.stringify(body));
  let truncated = false;
  if (message.length > cap) {
    message = message.slice(0, cap);
    truncated = true;
  }
  return { text: `::notice title=${encode(title)}::${message}`, truncated };
}
