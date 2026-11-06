;; Apex Studio — Pre-Phase 1 architecture spike (EXPERIMENTAL, NOT PRODUCTION)
;;
;; Deterministic gain -> biquad (transposed direct form II) kernel.
;;
;;   x[n]  = in[n] * gain                         (f32 input promoted to f64)
;;   y[n]  = b0*x[n] + z1
;;   z1'   = (b1*x[n] - a1*y[n]) + z2
;;   z2'   =  b2*x[n] - a2*y[n]
;;   out[n]= f32(y[n])                            (round-to-nearest-even)
;;
;; State is f64 per channel. After each sample |z| < 1e-30 is flushed to 0
;; because WebAssembly has no flush-to-zero / denormals-are-zero mode, and
;; subnormal arithmetic is slow on x86. The JS reference
;; (web/reference.mjs) mirrors this exact operation order so the two
;; implementations can be compared bit-for-bit.
;;
;; ABI v1 (fixed linear memory, no allocation, no growth, no imports):
;;   [0      .. 16384)  input  scratch: MAX_FRAMES f32
;;   [16384  .. 32768)  output scratch: MAX_FRAMES f32
;;   [32768  .. 32800)  state: MAX_CHANNELS x { z1: f64, z2: f64 }
;;
;; Return codes: 0 ok, -1 frames out of range, -2 channel out of range,
;;               -3 non-finite / out-of-range parameter
(module
  (memory (export "memory") 1)

  (global $IN_PTR      i32 (i32.const 0))
  (global $OUT_PTR     i32 (i32.const 16384))
  (global $STATE_PTR   i32 (i32.const 32768))
  (global $MAX_FRAMES  i32 (i32.const 4096))
  (global $MAX_CHANNELS i32 (i32.const 2))

  (global $gain (mut f64) (f64.const 1))
  (global $b0   (mut f64) (f64.const 1))
  (global $b1   (mut f64) (f64.const 0))
  (global $b2   (mut f64) (f64.const 0))
  (global $a1   (mut f64) (f64.const 0))
  (global $a2   (mut f64) (f64.const 0))

  (func (export "abi_version") (result i32) (i32.const 1))
  (func (export "input_ptr") (result i32) (global.get $IN_PTR))
  (func (export "output_ptr") (result i32) (global.get $OUT_PTR))
  (func (export "max_frames") (result i32) (global.get $MAX_FRAMES))
  (func (export "max_channels") (result i32) (global.get $MAX_CHANNELS))

  ;; finite(x) <=> x - x == 0  (false for NaN and +/-Infinity)
  (func $finite (param $x f64) (result i32)
    (f64.eq (f64.sub (local.get $x) (local.get $x)) (f64.const 0)))

  (func (export "configure")
    (param $gain f64) (param $b0 f64) (param $b1 f64) (param $b2 f64)
    (param $a1 f64) (param $a2 f64) (result i32)
    (if (i32.eqz
          (i32.and
            (i32.and
              (i32.and (call $finite (local.get $gain)) (call $finite (local.get $b0)))
              (i32.and (call $finite (local.get $b1)) (call $finite (local.get $b2))))
            (i32.and (call $finite (local.get $a1)) (call $finite (local.get $a2)))))
      (then (return (i32.const -3))))
    ;; reject absurd gain (> +24 dB) as a guard against unit mistakes
    (if (f64.gt (f64.abs (local.get $gain)) (f64.const 16))
      (then (return (i32.const -3))))
    (global.set $gain (local.get $gain))
    (global.set $b0 (local.get $b0))
    (global.set $b1 (local.get $b1))
    (global.set $b2 (local.get $b2))
    (global.set $a1 (local.get $a1))
    (global.set $a2 (local.get $a2))
    (i32.const 0))

  (func (export "reset")
    (local $p i32)
    (local.set $p (global.get $STATE_PTR))
    (block $done
      (loop $zero
        (br_if $done (i32.ge_u (local.get $p)
          (i32.add (global.get $STATE_PTR) (i32.mul (global.get $MAX_CHANNELS) (i32.const 16)))))
        (f64.store (local.get $p) (f64.const 0))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))
        (br $zero))))

  ;; Process `frames` samples of channel `ch` from IN scratch into OUT scratch.
  (func (export "process") (param $ch i32) (param $frames i32) (result i32)
    (local $i i32) (local $off i32) (local $sp i32)
    (local $x f64) (local $y f64) (local $z1 f64) (local $z2 f64)
    (if (i32.or (i32.lt_s (local.get $frames) (i32.const 0))
                (i32.gt_s (local.get $frames) (global.get $MAX_FRAMES)))
      (then (return (i32.const -1))))
    (if (i32.or (i32.lt_s (local.get $ch) (i32.const 0))
                (i32.ge_s (local.get $ch) (global.get $MAX_CHANNELS)))
      (then (return (i32.const -2))))
    (local.set $sp (i32.add (global.get $STATE_PTR) (i32.shl (local.get $ch) (i32.const 4))))
    (local.set $z1 (f64.load (local.get $sp)))
    (local.set $z2 (f64.load offset=8 (local.get $sp)))
    (block $done
      (loop $samples
        (br_if $done (i32.ge_s (local.get $i) (local.get $frames)))
        (local.set $off (i32.shl (local.get $i) (i32.const 2)))
        (local.set $x
          (f64.mul
            (f64.promote_f32 (f32.load (i32.add (global.get $IN_PTR) (local.get $off))))
            (global.get $gain)))
        (local.set $y
          (f64.add (f64.mul (global.get $b0) (local.get $x)) (local.get $z1)))
        (local.set $z1
          (f64.add
            (f64.sub (f64.mul (global.get $b1) (local.get $x))
                     (f64.mul (global.get $a1) (local.get $y)))
            (local.get $z2)))
        (local.set $z2
          (f64.sub (f64.mul (global.get $b2) (local.get $x))
                   (f64.mul (global.get $a2) (local.get $y))))
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
