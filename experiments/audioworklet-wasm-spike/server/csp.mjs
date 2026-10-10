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

export const CSP_MODES = {
  'csp-none': null,
  'csp-production': PRODUCTION_CSP,
  'csp-production-wasm': PRODUCTION_CSP_WITH_WASM,
};
