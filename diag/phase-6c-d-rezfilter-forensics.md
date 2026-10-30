# Phase 6C-D — RezFilter internal-state forensics

Isolated diagnostic branches only. Production `main` `358e5c77` and PR #292 `da44a1a` are not modified. Tag `v1.2.2` is not moved.

## 1. Source revision

Pinned SDK superproject: `vst3sdk` `9fad9770f2ae8542ab1a548a68c1ad1ac690abe0`.

Pinned `public.sdk` submodule: `a3911a4615dabbfdfd9d181ee26b05c70c289a95`.

File: `samples/vst/mda-vst3/source/mdaRezFilterProcessor.cpp`.

## 2. Implementation (read-only inspection)

Constructor: `setControllerClass` + `allocParameters(10)` only. Members `env`, `env2`, `phi`, `bufl`, `buf0/1/2`, `tatt`, `ttrig`, `lfomode` are not assigned.

`initialize`: writes default `params[0..9]`, then `recalculate()`. `recalculate` assigns `fff`, `fq`, `fg`, `fmax`, `fenv`, `att`, `rel`, `lfomode`, `flfo`, `dphi`, `tthr`. It does **not** assign `env`, `phi`, or the delay-line buffers.

`setActive`: `return BaseProcessor::setActive(state);` — no member zeroing.

`setProcessing(true)`: assigns `buf0 = 0.f; buf1 = 0.f; buf2 = 0.f;` (spaces). Does not assign `env`/`phi`.

`doProcessing`: `e=env`, `ph=phi`, `bl=bufl`. Frequency `f = fff + fenv*e + bl`. If `f<0` then `i=0` and `*out=b1` with no integrator step. Default overlay p3=0.5 ⇒ `fenv=0`; p6=0.5 ⇒ `flfo=0` **after** `recalculate`. Uninitialized `env` can still make `f<0` when `fenv≠0`; with the smoke overlay `fenv=0` that path is not assumed guilty.

Denormal tail uses unspaced `buf0=0.f;`. The candidate CMake fixture replaces that needle, not `setProcessing`. That replacement is a plugin-binary confound and is **not** treated as a production fix.

State restore is `BaseProcessor` `setState` while inactive, then host `setActive` / `setProcessing`, then effect parameter overlay.

## 3. Frozen binaries

Four-cell CI now builds each application/helper pair **once** and each plugin **once**. Cells download those artifacts and swap only the MDA bundle. Helper SHA-256 must match inside each application runtime.

Do not substitute the previous-run hashes `5e340a4c…` / `e783f03d…` for a later rebuild. Record the hashes actually loaded.

The instrumented plugin is a third binary. It must not be identified as either uninstrumented module.

## 4. Instrumentation

`APEX_MDA_REZFILTER_TRACE=ON` generates a separate MDA build. Snapshots copy existing member bit patterns into a preallocated ring. They do not assign DSP members. File I/O happens in `setProcessing(false)` only.

Instrumentation can change codegen/layout and therefore **can** affect reproduction. Silent vs audible comparison on the instrumented binary is evidence about that binary, not proof about the uninstrumented four-cell modules.

## 5. Independent save / reopen / stall

Save failure is recorded and does not skip reopen. Reopen success does not override save failure. Renderer-stall runs even when two-insert DSP fails. Independent completion is not overall smoke success.

## 6. Root cause

**Unknown.** Four-cell 41048023007 showed silent-insert on every uninstrumented app×plugin pair, with a higher overall fail rate on the main IPC app that mixed transport-stopped (audible DSP) and true silent-insert. Plugin CMake `buf0` fixture vs unpatched plugin did not control packaged silence. Internal members are not declared responsible until instrumented silent vs audible traces with frozen helpers and identical PCM say so.
