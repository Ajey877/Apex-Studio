;; Apex Studio — Pre-Phase 1 architecture spike (EXPERIMENTAL, NOT PRODUCTION)
;;
;; "Single engine" variant of gain_biquad.wat: ONE instance (one linear memory)
;; per AudioWorkletGlobalScope hosts up to MAX_SLOTS independent gain->biquad
;; units. Same per-sample arithmetic, in the same order, as gain_biquad.wat and
;; web/reference.mjs, so the output must be bit-identical.
;;
;; Why: every WebAssembly.Memory reserves 8 GiB of address space inside V8's
;; 1 TiB per-process sandbox, so a renderer can hold only ~125 of them (see
;; REPORT.md §8.3). One memory per audio thread removes the per-unit memory.
;;
;; ABI v2 (fixed memory: 2 pages, never grows, no imports):
;;   [0      .. 16384)   input  scratch: MAX_FRAMES f32
;;   [16384  .. 32768)   output scratch: MAX_FRAMES f32
;;   [32768  .. 114688)  MAX_SLOTS x 80-byte slot records:
;;        +0 gain +8 b0 +16 b1 +24 b2 +32 a1 +40 a2   (f64 parameters)
;;        +48 z1[ch0] +56 z2[ch0] +64 z1[ch1] +72 z2[ch1]   (f64 state)
;; Slot allocation/free lists live in JS on the audio thread (engine-processor.js).
;;
;; Return codes: 0 ok, -1 frames out of range, -2 channel/slot out of range,
;;               -3 non-finite / out-of-range parameter
(module
  (memory (export "memory") 2 2)

  (global $IN_PTR       i32 (i32.const 0))
  (global $OUT_PTR      i32 (i32.const 16384))
  (global $SLOTS_PTR    i32 (i32.const 32768))
  (global $SLOT_BYTES   i32 (i32.const 80))
  (global $MAX_FRAMES   i32 (i32.const 4096))
  (global $MAX_CHANNELS i32 (i32.const 2))
  (global $MAX_SLOTS    i32 (i32.const 1024))

  (func (export "abi_version") (result i32) (i32.const 2))
  (func (export "input_ptr") (result i32) (global.get $IN_PTR))
  (func (export "output_ptr") (result i32) (global.get $OUT_PTR))
  (func (export "max_frames") (result i32) (global.get $MAX_FRAMES))
  (func (export "max_channels") (result i32) (global.get $MAX_CHANNELS))
  (func (export "max_slots") (result i32) (global.get $MAX_SLOTS))

  (func $finite (param $x f64) (result i32)
    (f64.eq (f64.sub (local.get $x) (local.get $x)) (f64.const 0)))

  (func $slot_ptr (param $slot i32) (result i32)
    (i32.add (global.get $SLOTS_PTR) (i32.mul (local.get $slot) (global.get $SLOT_BYTES))))

  (func $valid_slot (param $slot i32) (result i32)
    (i32.and (i32.ge_s (local.get $slot) (i32.const 0))
             (i32.lt_s (local.get $slot) (global.get $MAX_SLOTS))))

  (func (export "configure_slot")
    (param $slot i32) (param $gain f64) (param $b0 f64) (param $b1 f64) (param $b2 f64)
    (param $a1 f64) (param $a2 f64) (result i32)
    (local $p i32)
    (if (i32.eqz (call $valid_slot (local.get $slot))) (then (return (i32.const -2))))
    (if (i32.eqz
          (i32.and
            (i32.and
              (i32.and (call $finite (local.get $gain)) (call $finite (local.get $b0)))
              (i32.and (call $finite (local.get $b1)) (call $finite (local.get $b2))))
            (i32.and (call $finite (local.get $a1)) (call $finite (local.get $a2)))))
      (then (return (i32.const -3))))
    (if (f64.gt (f64.abs (local.get $gain)) (f64.const 16))
      (then (return (i32.const -3))))
    (local.set $p (call $slot_ptr (local.get $slot)))
    (f64.store offset=0  (local.get $p) (local.get $gain))
    (f64.store offset=8  (local.get $p) (local.get $b0))
    (f64.store offset=16 (local.get $p) (local.get $b1))
    (f64.store offset=24 (local.get $p) (local.get $b2))
    (f64.store offset=32 (local.get $p) (local.get $a1))
    (f64.store offset=40 (local.get $p) (local.get $a2))
    (i32.const 0))

  (func (export "reset_slot") (param $slot i32) (result i32)
    (local $p i32)
    (if (i32.eqz (call $valid_slot (local.get $slot))) (then (return (i32.const -2))))
    (local.set $p (call $slot_ptr (local.get $slot)))
    (f64.store offset=48 (local.get $p) (f64.const 0))
    (f64.store offset=56 (local.get $p) (f64.const 0))
    (f64.store offset=64 (local.get $p) (f64.const 0))
    (f64.store offset=72 (local.get $p) (f64.const 0))
    (i32.const 0))

  ;; Process `frames` samples of channel `ch` of unit `slot`: IN scratch -> OUT scratch.
  (func (export "process_slot") (param $slot i32) (param $ch i32) (param $frames i32) (result i32)
    (local $i i32) (local $off i32) (local $p i32) (local $sp i32)
    (local $gain f64) (local $b0 f64) (local $b1 f64) (local $b2 f64) (local $a1 f64) (local $a2 f64)
    (local $x f64) (local $y f64) (local $z1 f64) (local $z2 f64)
    (if (i32.or (i32.lt_s (local.get $frames) (i32.const 0))
                (i32.gt_s (local.get $frames) (global.get $MAX_FRAMES)))
      (then (return (i32.const -1))))
    (if (i32.eqz (call $valid_slot (local.get $slot))) (then (return (i32.const -2))))
    (if (i32.or (i32.lt_s (local.get $ch) (i32.const 0))
                (i32.ge_s (local.get $ch) (global.get $MAX_CHANNELS)))
      (then (return (i32.const -2))))
    (local.set $p (call $slot_ptr (local.get $slot)))
    (local.set $gain (f64.load offset=0  (local.get $p)))
    (local.set $b0   (f64.load offset=8  (local.get $p)))
    (local.set $b1   (f64.load offset=16 (local.get $p)))
    (local.set $b2   (f64.load offset=24 (local.get $p)))
    (local.set $a1   (f64.load offset=32 (local.get $p)))
    (local.set $a2   (f64.load offset=40 (local.get $p)))
    (local.set $sp (i32.add (i32.add (local.get $p) (i32.const 48)) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $z1 (f64.load (local.get $sp)))
    (local.set $z2 (f64.load offset=8 (local.get $sp)))
    (block $done
      (loop $samples
        (br_if $done (i32.ge_s (local.get $i) (local.get $frames)))
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
