#!/usr/bin/env python3
"""Stage B verification analyzer — baseline (no lead) vs fixed (start lead)."""
import json, sys, statistics as st, math, random
from collections import Counter

SR = 44100
Q = 128 / SR


def pct(vals, p):
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p / 100.0
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def stats(vals):
    return dict(n=len(vals), min=min(vals), median=st.median(vals),
                p90=pct(vals, 90), max=max(vals))


def ms(v):
    return f"{v*1000:+.3f} ms"


def control_gap_error(run, sr):
    """Spacing error across gaps NOT involving the suspect N0 burst.
    Capture-integrity check: must be ~0 or the stream has gaps."""
    labels, delays, ons = run['labels'], run['delays'], run['onsetSamples']
    worst = 0.0
    for k in range(1, len(ons)):
        if labels[k - 1] == 'N0' or labels[k] == 'N0':
            continue
        worst = max(worst, abs((ons[k] - ons[k - 1]) - (delays[k] - delays[k - 1]) * sr))
    return worst


def report(path, tag):
    d = json.load(open(path))
    print("=" * 76)
    print(f"  {tag}")
    print("=" * 76)
    gp = d.get('gapProof', {}).get('data', [])
    if gp:
        print(f"CAPTURE GROUND TRUTH  impulses {sum(g['detected'] for g in gp)}/{sum(g['impulseCount'] for g in gp)}"
              f"   maxAbsSpacingErr {max(g['maxAbsSpacingErrorSamples'] for g in gp)} samp"
              f"   drops {sum(g['coverage']['droppedBuffers'] for g in gp)}")
    for cond in [k for k in d if k != 'gapProof']:
        data = d[cond]['data']
        runs = [r for r in data['results'] if r.get('valid')]
        sr = runs[0]['sampleRate']
        q = 128.0 / sr
        cge = [control_gap_error(r, sr) for r in runs if r['onsetCount'] > 1]
        print(f"\n--- {cond} ({data.get('contextMode','')}, sr={sr}, buf={data.get('bufferSize')}) ---")
        print(f"  runs {len(runs)}   onset mismatches {sum(1 for r in runs if r['onsetCount']!=r['expectedOnsetCount'])}"
              f"   drops {sum(r['capture']['droppedBuffers'] for r in runs)}"
              f"   control-gap err max {max(cge):.0f} samp ({max(cge)/sr*1000:.3f} ms)")
        print(f"  1 quantum = {q*1000:.4f} ms")
        if cond.startswith('bare'):
            for lab in ('N0', 'Nsmall0', 'Nsmall1', 'Nref', 'N8'):
                vals = [r['results'][lab]['latenessVsRefSeconds'] for r in runs if r['results'].get(lab)]
                if not vals:
                    continue
                s = stats(vals)
                over1 = sum(1 for v in vals if v > q)
                print(f"    {lab:<8} median {ms(s['median']):>11}  p90 {ms(s['p90']):>11}"
                      f"  max {ms(s['max']):>11}   >1q {over1}/{len(vals)}")
        else:
            pairs = []
            for r in runs:
                rr = r['results']
                if rr.get('N0') and rr.get('N8') and rr.get('Nref'):
                    pairs.append((rr['N0']['latenessVsRefSeconds'] - rr['N8']['latenessVsRefSeconds'],
                                  rr['N0']['latenessVsRefSeconds'] - rr['Nref']['latenessVsRefSeconds'],
                                  rr['N8']['latenessVsRefSeconds'] - rr['Nref']['latenessVsRefSeconds']))
            for idx, name in ((0, 'N0 - N8   [PRIMARY: same voice, bias cancels]'),
                              (1, 'N0 - Nref [absolute; constant waveform bias]'),
                              (2, 'N8 - Nref [control: must NOT move]')):
                vals = [p[idx] for p in pairs]
                s = stats(vals)
                print(f"    {name}")
                print(f"             median {ms(s['median']):>11}  p90 {ms(s['p90']):>11}"
                      f"  max {ms(s['max']):>11}  min {ms(s['min']):>11}"
                      f"   >1q {sum(1 for v in vals if v>q)}/{len(vals)}")
    print()


def compare(bpath, fpath):
    def eng(p):
        rs = [r for r in json.load(open(p))['engine_reused']['data']['results'] if r.get('valid')]
        return [(r['results']['N0']['latenessVsRefSeconds'] - r['results']['N8']['latenessVsRefSeconds']) for r in rs]
    B, F = eng(bpath), eng(fpath)
    print("=" * 76)
    print("  ENGINE, production audioEngine.play()  —  first-note lateness (N0 - N8)")
    print("=" * 76)
    print(f"{'metric':<24}{'BASELINE':>15}{'FIXED':>15}{'delta':>15}")
    for name, b, f in (("runs", len(B), len(F)),
                       ("median (ms)", st.median(B)*1000, st.median(F)*1000),
                       ("p90 (ms)", pct(B,90)*1000, pct(F,90)*1000),
                       ("max (ms)", max(B)*1000, max(F)*1000),
                       ("mean (ms)", st.mean(B)*1000, st.mean(F)*1000)):
        d = f"{f-b:+.3f}" if isinstance(b, float) else ""
        print(f"{name:<24}{b:>15.3f}{f:>15.3f}{d:>15}")
    print()
    for thr, lab in ((Q,'> 1 quantum'), (2*Q,'> 2 quanta'), (3*Q,'> 3 quanta')):
        cb, cf = sum(1 for v in B if v > thr), sum(1 for v in F if v > thr)
        print(f"{lab:<24}{f'{cb}/{len(B)} ({100*cb/len(B):.0f}%)':>15}"
              f"{f'{cf}/{len(F)} ({100*cf/len(F):.0f}%)':>15}{f'{(cf-cb)/len(B)*100:+.0f} pp':>15}")
    print()
    for tag, V in (("BASELINE", B), ("FIXED", F)):
        c = Counter(round(v / Q) for v in V)
        print(f"  {tag} modes (quanta): " + "  ".join(f"{k:+d}q:{c[k]:3d} ({100*c[k]/len(V):4.1f}%)" for k in sorted(c)))
    print()
    cb, cf = sum(1 for v in B if v > Q), sum(1 for v in F if v > Q)
    pb, pf = cb/len(B), cf/len(F); pp = (cb+cf)/(len(B)+len(F))
    se = math.sqrt(pp*(1-pp)*(1/len(B)+1/len(F)))
    z = (pb-pf)/se
    pv = 2*(1-0.5*(1+math.erf(abs(z)/math.sqrt(2))))
    print(f"Two-proportion test P(>1 quantum): {pb:.3f} -> {pf:.3f}   z={z:.3f}  p={pv:.3e}"
          + ("  SIGNIFICANT" if pv < 0.05 else "  not significant"))
    # Mann-Whitney (tie-corrected normal approx)
    n1, n2 = len(B), len(F)
    allv = sorted([(v, 0) for v in B] + [(v, 1) for v in F])
    ranks = [0]*len(allv); i = 0; ties = []
    while i < len(allv):
        j = i
        while j+1 < len(allv) and allv[j+1][0] == allv[i][0]:
            j += 1
        r = (i+j)/2 + 1
        for k in range(i, j+1):
            ranks[k] = r
        ties.append(j-i+1); i = j+1
    R1 = sum(ranks[k] for k in range(len(allv)) if allv[k][1] == 0)
    U1 = R1 - n1*(n1+1)/2
    N = n1+n2
    tc = sum(t**3 - t for t in ties)
    sd = math.sqrt((n1*n2/12)*((N+1) - tc/(N*(N-1))))
    z2 = (U1 - n1*n2/2)/sd
    pv2 = 2*(1-0.5*(1+math.erf(abs(z2)/math.sqrt(2))))
    print(f"Mann-Whitney U={U1:.0f}  z={z2:.3f}  p={pv2:.3e}  P(fixed<baseline)={U1/(n1*n2):.3f}"
          + ("  SIGNIFICANT" if pv2 < 0.05 else "  not significant"))
    random.seed(7)
    bs = []
    for _ in range(20000):
        bs.append(st.median(random.choices(F, k=len(F))) - st.median(random.choices(B, k=len(B))))
    bs.sort()
    print(f"Bootstrap 95% CI median(F)-median(B): [{bs[int(.025*len(bs))]*1000:+.3f}, {bs[int(.975*len(bs))]*1000:+.3f}] ms"
          f"   (point {(st.median(F)-st.median(B))*1000:+.3f} ms)")
    print()


if __name__ == '__main__':
    if len(sys.argv) == 2:
        report(sys.argv[1], sys.argv[2])
    else:
        report(sys.argv[1], "BASELINE  f8aa99c  (main, no start lead)")
        report(sys.argv[2], "FIXED     89370e0  (main + start lead)")
        compare(sys.argv[1], sys.argv[2])
