#!/usr/bin/env python3
"""
board-misses.py — the granular review Michael keeps asking for.

For a board transcript, print EVERY question where a target arm was wrong, with:
  - the question + choices + gold answer + what the arm predicted
  - whether the OTHER arm (default baseline) got it right (i.e. did retrieval BREAK it?)
  - the EXACT retrieved context that was fed (from brain_ctx), so we can judge whether
    retrieval was question-precise or merely subject-topical.

Usage:
  board-misses.py --ckpt board.jsonl --arm brain --vs baseline [--only-regressions] [--limit N]
"""
import argparse, json, textwrap

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--arm', default='brain', help='arm whose misses to review')
    ap.add_argument('--vs', default='baseline', help='comparison arm')
    ap.add_argument('--only-regressions', action='store_true',
                    help='only questions the vs-arm got RIGHT but --arm got wrong (retrieval broke it)')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(a.ckpt) if l.strip()]
    A, V = a.arm, a.vs
    misses = [r for r in rows if r.get(f'{A}_ok') is False]
    if a.only_regressions:
        misses = [r for r in misses if r.get(f'{V}_ok') is True]

    tot = len(rows)
    reg = sum(1 for r in rows if r.get(f'{A}_ok') is False and r.get(f'{V}_ok') is True)
    helped = sum(1 for r in rows if r.get(f'{A}_ok') is True and r.get(f'{V}_ok') is False)
    print(f"# {A} vs {V} over {tot} questions")
    print(f"#   {A} broke {reg} that {V} got right   |   {A} fixed {helped} that {V} got wrong")
    print(f"#   showing {len(misses)}{' regressions' if a.only_regressions else f' {A} misses'}\n")

    for i, r in enumerate(misses):
        if a.limit and i >= a.limit:
            print(f"... (+{len(misses)-a.limit} more)"); break
        q = r.get('question', '?'); ch = r.get('choices', [])
        gold = r.get('gold', r.get('answer', '?'))
        pred = r.get(f'{A}_pred', '?'); vpred = r.get(f'{V}_pred', '?')
        conf = r.get('brain_conf', '?')
        print("─" * 88)
        print(f"[{r.get('subject','?')}]  gold={gold}   {A}={pred} ✗   {V}={vpred} {'✓' if r.get(f'{V}_ok') else '✗'}   retr-conf={conf}")
        print(textwrap.fill(q.strip(), 88, initial_indent='  Q: ', subsequent_indent='     '))
        for j, c in enumerate(ch):
            print(f"     {chr(65+j)}. {c}")
        ctx = r.get('brain_ctx')
        if ctx:
            print("  CONTEXT FED (what retrieval put in front of the model):")
            for k, h in enumerate(ctx):
                head = f"    [{k+1}] {h.get('slug','?')} · {h.get('material','?')} · cos={h.get('score','?')}"
                print(head)
                print(textwrap.fill(h.get('text','').strip(), 84, initial_indent='        ', subsequent_indent='        '))
        else:
            print("  CONTEXT FED: <not captured — run with MMLU_CAPTURE_CTX=1>")
        print()

if __name__ == '__main__':
    main()
