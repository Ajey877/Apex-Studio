// CSP strings used by the spike. PRODUCTION_CSP must stay byte-identical to the
// policy electron.cjs applies to the packaged app; tests/node/isolation.test.mjs
// re-extracts it from electron.cjs and fails if the two drift apart.
export const PRODUCTION_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
];

export const PRODUCTION_CSP = PRODUCTION_CSP_DIRECTIVES.join('; ');

/** The minimal change that would permit WebAssembly compilation (NOT applied to production). */
export const PRODUCTION_CSP_WITH_WASM = PRODUCTION_CSP_DIRECTIVES
  .map(d => (d === "script-src 'self'" ? "script-src 'self' 'wasm-unsafe-eval'" : d))
  .join('; ');

// ---- Investigation-only variants (none of these are applied to production) ----
const replaceDirective = (from, to) => PRODUCTION_CSP_DIRECTIVES.map(d => (d === from ? to : d)).join('; ');
/** 'wasm-unsafe-eval' only in default-src; script-src 'self' is present, so it should still govern. */
export const PRODUCTION_CSP_WASM_IN_DEFAULT_SRC_ONLY = replaceDirective("default-src 'self'", "default-src 'self' 'wasm-unsafe-eval'");
/** Broader alternative: 'unsafe-eval' also permits eval()/new Function(). Not recommended. */
export const PRODUCTION_CSP_WITH_UNSAFE_EVAL = replaceDirective("script-src 'self'", "script-src 'self' 'unsafe-eval'");

/**
 * Mode -> policy. A string/null applies to every response. An object
 * { document, worklet } applies `worklet` to AudioWorklet/Worker script
 * responses (files named *-processor.js / *-worker.js) and `document` to
 * everything else, to determine which policy governs WASM inside a worklet.
 */
export const CSP_MODES = {
  'csp-none': null,
  'csp-production': PRODUCTION_CSP,
  'csp-production-wasm': PRODUCTION_CSP_WITH_WASM,
  'csp-production-wasm-default-src-only': PRODUCTION_CSP_WASM_IN_DEFAULT_SRC_ONLY,
  'csp-production-unsafe-eval': PRODUCTION_CSP_WITH_UNSAFE_EVAL,
  'csp-split-docwasm-scriptprod': { document: PRODUCTION_CSP_WITH_WASM, worklet: PRODUCTION_CSP },
  'csp-split-docprod-scriptwasm': { document: PRODUCTION_CSP, worklet: PRODUCTION_CSP_WITH_WASM },
};

export function cspFor(mode, filePath) {
  const v = CSP_MODES[mode];
  if (v === null || typeof v === 'string') return v;
  return /-(processor|worker)\.js$/.test(filePath) ? v.worklet : v.document;
}
