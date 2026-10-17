#!/usr/bin/env python3
"""Gate: prove the campaign ran the intended bundle.

Under Option A the transport anchors start() at now + 0.030 s, so
(scheduledStep0 - tCall) must be ~30 ms; on a no-lead baseline it is ~0 ms.
A 304/cached bundle shows up here as the wrong offset.
"""
import json, sys, statistics as st
path, expect_ms = sys.argv[1], float(sys.argv[2])
d = json.load(open(path)); ok = True
for cond in [k for k in d if k != 'gapProof']:
    rs = [r for r in d[cond]['data']['results'] if r.get('valid')]
    if not rs or 'scheduledStep0' not in rs[0]: continue
    v = [(r['scheduledStep0'] - r['tCall']) * 1000 for r in rs]
    med = st.median(v); good = abs(med - expect_ms) < 1.0; ok = ok and good
    print(f"  [{'OK ' if good else 'FAIL'}] {cond}: median(scheduledStep0-tCall)={med:+.3f} ms (expect ~{expect_ms:+.1f}), n={len(rs)}")
print("  GATE:", "PASS - correct bundle confirmed" if ok else "FAIL - WRONG BUNDLE SERVED")
sys.exit(0 if ok else 1)
