;; Isolated prototype of a single WASM engine with a fixed DSP-slot table.
;; This is NOT used by the production app or the original AudioWorklet harness.
;; One WebAssembly.Instance owns one fixed 64 KiB memory; up to 512 logical
;; biquad slots live in that memory. `process(slot, channel, frames)` reuses one
;; input/output scratch buffer while keeping parameter and filter state per slot.
;;
;; Memory layout (all offsets in bytes):
;;   [0 .. 512)       input scratch (128 f32 frames)
;;   [512 .. 1024)    output scratch (128 f32 frames)
;;   [4096 .. 53248)  512 slots x 96 bytes
;; Each slot: active:i32, padding:i32, gain/b0/b1/b2/a1/a2:f64,
;;            z1/z2 state for channel 0 and channel 1 (4 x f64).
;; No allocation, memory growth, imports, atomics, or per-slot WASM instances.
(module
  (memory (export "memory") 1)

  (global $IN_PTR i32 (i32.const 0))
  (global $OUT_PTR i32 (i32.const 512))
  (global $SLOT_PTR i32 (i32.const 4096))
  (global $MAX_FRAMES i32 (i32.const 128))
  (global $MAX_SLOTS i32 (i32.const 512))
  (global $SLOT_STRIDE i32 (i32.const 96))

  (func (export "abi_version") (result i32) (i32.const 1))
  (func (export "input_ptr") (result i32) (global.get $IN_PTR))
  (func (export "output_ptr") (result i32) (global.get $OUT_PTR))
  (func (export "max_frames") (result i32) (global.get $MAX_FRAMES))
  (func (export "slot_capacity") (result i32) (global.get $MAX_SLOTS))

  (func $slot_ptr (param $slot i32) (result i32)
    (i32.add
      (global.get $SLOT_PTR)
      (i32.mul (local.get $slot) (global.get $SLOT_STRIDE))))

  ;; finite(x) <=> x - x == 0 (false for NaN and +/-Infinity).
  (func $finite (param $x f64) (result i32)
    (f64.eq (f64.sub (local.get $x) (local.get $x)) (f64.const 0)))

  (func $zero_state (param $ptr i32)
    (f64.store offset=56 (local.get $ptr) (f64.const 0))
    (f64.store offset=64 (local.get $ptr) (f64.const 0))
    (f64.store offset=72 (local.get $ptr) (f64.const 0))
    (f64.store offset=80 (local.get $ptr) (f64.const 0)))

  ;; Return the first free slot, or -1 when the fixed table is full.
  (func (export "slot_create") (result i32)
    (local $slot i32) (local $ptr i32)
    (block $full
      (loop $find
        (br_if $full (i32.ge_u (local.get $slot) (global.get $MAX_SLOTS)))
        (local.set $ptr (call $slot_ptr (local.get $slot)))
        (if (i32.eqz (i32.load (local.get $ptr)))
          (then
            (i32.store (local.get $ptr) (i32.const 1))
            (f64.store offset=8 (local.get $ptr) (f64.const 1))
            (f64.store offset=16 (local.get $ptr) (f64.const 1))
            (f64.store offset=24 (local.get $ptr) (f64.const 0))
            (f64.store offset=32 (local.get $ptr) (f64.const 0))
            (f64.store offset=40 (local.get $ptr) (f64.const 0))
            (f64.store offset=48 (local.get $ptr) (f64.const 0))
            (call $zero_state (local.get $ptr))
            (return (local.get $slot))))
        (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
        (br $find)))
    (i32.const -1))

  (func (export "live_slots") (result i32)
    (local $slot i32) (local $ptr i32) (local $count i32)
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $slot) (global.get $MAX_SLOTS)))
        (local.set $ptr (call $slot_ptr (local.get $slot)))
        (if (i32.ne (i32.load (local.get $ptr)) (i32.const 0))
          (then (local.set $count (i32.add (local.get $count) (i32.const 1)))))
        (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
        (br $scan)))
    (local.get $count))

  ;; Return 0 on success, -1 for an invalid index, -2 if the slot is not live.
  (func (export "slot_destroy") (param $slot i32) (result i32)
    (local $ptr i32)
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.ge_s (local.get $slot) (global.get $MAX_SLOTS)))
      (then (return (i32.const -1))))
    (local.set $ptr (call $slot_ptr (local.get $slot)))
    (if (i32.eqz (i32.load (local.get $ptr)))
      (then (return (i32.const -2))))
    (i32.store (local.get $ptr) (i32.const 0))
    (call $zero_state (local.get $ptr))
    (i32.const 0))

  ;; Return 0 on success, -1 invalid index, -2 inactive slot, -3 bad parameters.
  (func (export "slot_configure")
    (param $slot i32) (param $gain f64) (param $b0 f64) (param $b1 f64)
    (param $b2 f64) (param $a1 f64) (param $a2 f64) (result i32)
    (local $ptr i32)
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.ge_s (local.get $slot) (global.get $MAX_SLOTS)))
      (then (return (i32.const -1))))
    (local.set $ptr (call $slot_ptr (local.get $slot)))
    (if (i32.eqz (i32.load (local.get $ptr)))
      (then (return (i32.const -2))))
    (if (i32.eqz
          (i32.and
            (i32.and
              (i32.and (call $finite (local.get $gain)) (call $finite (local.get $b0)))
              (i32.and (call $finite (local.get $b1)) (call $finite (local.get $b2))))
            (i32.and (call $finite (local.get $a1)) (call $finite (local.get $a2)))))
      (then (return (i32.const -3))))
    (if (f64.gt (f64.abs (local.get $gain)) (f64.const 16))
      (then (return (i32.const -3))))
    (f64.store offset=8 (local.get $ptr) (local.get $gain))
    (f64.store offset=16 (local.get $ptr) (local.get $b0))
    (f64.store offset=24 (local.get $ptr) (local.get $b1))
    (f64.store offset=32 (local.get $ptr) (local.get $b2))
    (f64.store offset=40 (local.get $ptr) (local.get $a1))
    (f64.store offset=48 (local.get $ptr) (local.get $a2))
    (i32.const 0))

  ;; Reset both channel states for one live slot.
  (func (export "slot_reset") (param $slot i32) (result i32)
    (local $ptr i32)
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.ge_s (local.get $slot) (global.get $MAX_SLOTS)))
      (then (return (i32.const -1))))
    (local.set $ptr (call $slot_ptr (local.get $slot)))
    (if (i32.eqz (i32.load (local.get $ptr)))
      (then (return (i32.const -2))))
    (call $zero_state (local.get $ptr))
    (i32.const 0))

  ;; Process one channel of the shared input scratch into the shared output
  ;; scratch. The state and coefficients are indexed by logical slot.
  ;; Return 0 on success, -1 bad slot, -2 bad frame count, -3 bad channel,
  ;; -4 inactive slot.
  (func (export "process") (param $slot i32) (param $ch i32)
    (param $frames i32) (result i32)
    (local $ptr i32) (local $sp i32) (local $i i32) (local $off i32)
    (local $gain f64) (local $b0 f64) (local $b1 f64) (local $b2 f64)
    (local $a1 f64) (local $a2 f64) (local $x f64) (local $y f64)
    (local $z1 f64) (local $z2 f64)
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.ge_s (local.get $slot) (global.get $MAX_SLOTS)))
      (then (return (i32.const -1))))
    (if (i32.or (i32.lt_s (local.get $frames) (i32.const 0))
                (i32.gt_s (local.get $frames) (global.get $MAX_FRAMES)))
      (then (return (i32.const -2))))
    (if (i32.or (i32.lt_s (local.get $ch) (i32.const 0))
                (i32.ge_s (local.get $ch) (i32.const 2)))
      (then (return (i32.const -3))))
    (local.set $ptr (call $slot_ptr (local.get $slot)))
    (if (i32.eqz (i32.load (local.get $ptr)))
      (then (return (i32.const -4))))
    (local.set $gain (f64.load offset=8 (local.get $ptr)))
    (local.set $b0 (f64.load offset=16 (local.get $ptr)))
    (local.set $b1 (f64.load offset=24 (local.get $ptr)))
    (local.set $b2 (f64.load offset=32 (local.get $ptr)))
    (local.set $a1 (f64.load offset=40 (local.get $ptr)))
    (local.set $a2 (f64.load offset=48 (local.get $ptr)))
    (local.set $sp
      (i32.add (local.get $ptr)
        (i32.add (i32.const 56) (i32.shl (local.get $ch) (i32.const 4)))))
    (local.set $z1 (f64.load (local.get $sp)))
    (local.set $z2 (f64.load offset=8 (local.get $sp)))
    (block $done
      (loop $samples
        (br_if $done (i32.ge_u (local.get $i) (local.get $frames)))
        (local.set $off (i32.shl (local.get $i) (i32.const 2)))
        (local.set $x
          (f64.mul
            (f64.promote_f32 (f32.load (i32.add (global.get $IN_PTR) (local.get $off))))
            (local.get $gain)))
        (local.set $y
          (f64.add (f64.mul (local.get $b0) (local.get $x)) (local.get $z1)))
        (local.set $z1
          (f64.add
            (f64.sub (f64.mul (local.get $b1) (local.get $x))
                     (f64.mul (local.get $a1) (local.get $y)))
            (local.get $z2)))
        (local.set $z2
          (f64.sub (f64.mul (local.get $b2) (local.get $x))
                   (f64.mul (local.get $a2) (local.get $y))))
        (if (f64.lt (f64.abs (local.get $z1)) (f64.const 1e-30))
          (then (local.set $z1 (f64.const 0))))
        (if (f64.lt (f64.abs (local.get $z2)) (f64.const 1e-30))
          (then (local.set $z2 (f64.const 0))))
        (f32.store (i32.add (global.get $OUT_PTR) (local.get $off))
                   (f32.demote_f64 (local.get $y)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $samples)))
    (f64.store (local.get $sp) (local.get $z1))
    (f64.store offset=8 (local.get $sp) (local.get $z2))
    (i32.const 0))
)
