#!/usr/bin/env python3
"""board-analysis — rigorous readout of an MMLU brain-bench checkpoint.

Replaces eyeballing. Given a ckpt.jsonl (one row per question, with <arm>_ok booleans), it computes:
  * per-arm OVERALL accuracy + per-subject breakdown
  * a v0-style delta table vs a --baseline arm
  * McNemar's EXACT test between two --compare arms — is the difference REAL or sampling noise?

McNemar is the right test for two classifiers on the SAME items (paired): it looks only at the DISCORDANT
questions (one arm right, the other wrong). b = A-right/B-wrong, c = A-wrong/B-right; the exact two-sided
p-value is the binomial tail on min(b,c) out of b+c at p=0.5 — stdlib only, no scipy.

Usage:
  python3 scripts/board-analysis.py --ckpt ckpt-kgbert0630.jsonl                       # full table
  python3 scripts/board-analysis.py --ckpt ckpt-kgbert0630.jsonl --compare ground_kgbert ground --baseline baseline
"""
import argparse
import json
import math
import sys
from collections import defaultdict


def binom_two_sided_p(k, n):
    """Exact two-sided binomial p-value for k successes in n trials at p=0.5 (McNemar exact)."""
    if n == 0:
        return 1.0
    # sum the tail at min(k, n-k), double it, cap at 1
    lo = min(k, n - k)
    tail = sum(math.comb(n, i) for i in range(0, lo + 1)) * (0.5 ** n)
    return min(1.0, 2.0 * tail)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--baseline', default='baseline', help='arm to delta everything against')
    ap.add_argument('--compare', nargs=2, metavar=('ARM_A', 'ARM_B'),
                    help='run McNemar between these two arms')
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(a.ckpt) if l.strip()]
    if not rows:
        print('empty ckpt', file=sys.stderr); sys.exit(2)
    # discover arms from *_ok keys
    arms = sorted({k[:-3] for r in rows for k in r if k.endswith('_ok')})
    n = len(rows)
    tot = {arm: 0 for arm in arms}
    persub = defaultdict(lambda: defaultdict(int))
    persub_n = defaultdict(int)
    for r in rows:
        persub_n[r.get('subject', '?')] += 1
        for arm in arms:
            if r.get(arm + '_ok'):
                tot[arm] += 1
                persub[r.get('subject', '?')][arm] += 1

    base = a.baseline if a.baseline in arms else None
    # LOG-AXIS view (the frontier lens): near the ceiling, accuracy-scale deltas understate
    # everything — 95.0%→95.25% is a tiny accuracy bump but a 5% RELATIVE error reduction.
    # Report error rate, relative-error-vs-baseline, and logit alongside accuracy.
    import math
    def logit(pv):
        pv = min(max(pv, 0.5 / n), 1 - 0.5 / n)   # continuity clamp so 0%/100% stay finite
        return math.log(pv / (1 - pv))
    print(f'\n=== OVERALL (n={n}) — accuracy + error-scale (log axis) ===')
    print(f'  {"arm":16} {"acc":>6} {"err":>7} {"rel-err vs base":>16} {"Δlogit":>8}')
    base_err = (n - tot[base]) / n if base else None
    for arm in sorted(arms, key=lambda x: -tot[x]):
        acc = 100 * tot[arm] / n
        err = (n - tot[arm]) / n
        rel = f'{(err / base_err - 1):+7.0%}' if base and base_err > 0 and arm != base else ('   base' if arm == base else '      —')
        dl = f'{logit(1 - err) - logit(1 - base_err):+8.3f}' if base and arm != base else '       —'
        star = '  ← baseline' if arm == base else ''
        print(f'  {arm:16} {acc:5.1f}% {100*err:6.2f}% {rel:>16} {dl:>8}{star}')

    print(f'\n=== PER-SUBJECT (acc %) ===')
    hdr = '  ' + f'{"subject":26}' + ''.join(f'{arm[:10]:>11}' for arm in arms)
    print(hdr)
    for s in persub_n:
        sn = persub_n[s]
        print('  ' + f'{s:26}' + ''.join(f'{100*persub[s][arm]/sn:10.0f} ' for arm in arms))

    if a.compare:
        A, B = a.compare
        if A not in arms or B not in arms:
            print(f'\n[McNemar] one of {A}/{B} not in ckpt arms {arms}', file=sys.stderr); return
        b = sum(1 for r in rows if r.get(A + '_ok') and not r.get(B + '_ok'))   # A right, B wrong
        c = sum(1 for r in rows if not r.get(A + '_ok') and r.get(B + '_ok'))   # A wrong, B right
        p = binom_two_sided_p(min(b, c), b + c)
        acc_a, acc_b = 100 * tot[A] / n, 100 * tot[B] / n
        print(f'\n=== McNEMAR: {A} vs {B} (paired, same {n} questions) ===')
        print(f'  {A}={acc_a:.1f}%  {B}={acc_b:.1f}%  (Δ {acc_a-acc_b:+.1f}pp)')
        err_a, err_b = 1 - tot[A] / n, 1 - tot[B] / n
        if err_b > 0:
            print(f'  error scale: {A} {100*err_a:.2f}% vs {B} {100*err_b:.2f}% → {A} has {err_a/err_b-1:+.0%} relative errors')
        print(f'  discordant: {A}-only-right b={b}, {B}-only-right c={c}  (concordant ignored)')
        print(f'  exact two-sided p = {p:.4f}  →  ' +
              ('SIGNIFICANT (p<0.05): the difference is real, not sampling noise' if p < 0.05
               else 'NOT significant (p≥0.05): within noise — need more n or a bigger effect'))
        # power honesty: what absolute-pp difference could THIS n even detect (80% power)?
        import math as _m
        p_err = (err_a + err_b) / 2
        if p_err > 0:
            mde = ( (1.96 + 0.84) * _m.sqrt(2 * p_err) ) / _m.sqrt(n)
            print(f'  minimum detectable effect at n={n}: ~±{100*mde:.1f}pp — differences smaller than this are INVISIBLE to this board')


if __name__ == '__main__':
    main()
