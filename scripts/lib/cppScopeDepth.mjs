/**
 * Brace-depth reader for a C++ translation unit, ignoring braces that appear
 * inside `//` comments and inside string or character literals.
 *
 * It exists because of a real Windows-only build failure: a file-scope variable
 * was inserted immediately before a member function and landed inside the class
 * body instead. MSVC rejected it with C2864 (a static data member with an
 * in-class initializer), and the error only appeared in CI, because the host
 * translation unit cannot be compiled here without the VST3 SDK headers.
 *
 * This is a brace counter, not a C++ parser: it does not understand preprocessor
 * conditionals, raw string literals, or block comments. That is enough to answer
 * the one question it is used for - is this declaration at file scope?
 */
function stripLiteralsAndLineComment(line) {
  let j = 0;
  const out = [];
  while (j < line.length) {
    const c = line[j];
    if (c === '/' && line[j + 1] === '/') break;  // rest of the line is a comment
    if (c === '"' || c === "'") {
      const quote = c;
      j += 1;
      while (j < line.length && line[j] !== quote) {
        j += line[j] === '\\' ? 2 : 1;  // skip escaped characters
      }
      j += 1;
      continue;  // the literal's braces are not structural
    }
    out.push(c);
    j += 1;
  }
  return out.join('');
}

/** Brace depth in effect immediately BEFORE the given 1-based line number. */
export function braceDepthBeforeLine(source, lineNumber) {
  const lines = String(source).split('\n');
  if (lineNumber < 1 || lineNumber > lines.length) {
    throw new RangeError(`line ${lineNumber} is outside the file (${lines.length} lines)`);
  }
  let depth = 0;
  for (const line of lines.slice(0, lineNumber - 1)) {
    const text = stripLiteralsAndLineComment(line);
    depth += text.split('{').length - 1;
    depth -= text.split('}').length - 1;
  }
  return depth;
}

/** 1-based line of the first line matching the predicate, or null. */
export function findLine(source, predicate) {
  const lines = String(source).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i], i + 1)) return i + 1;
  }
  return null;
}
