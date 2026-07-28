#!/usr/bin/env python3
"""
board-misses.py — the granular failure review: full chain per wrong answer + retrieval-vs-generation attribution.

RAG is at least two stages, so a wrong answer fails in one of two places, and we must know which:
  RETRIEVAL failure  — the answer-bearing fact is NOT in the context we brought back → sharpen vector retrieval / query-gen
  GENERATION failure — the fact WAS in the context and the model still answered wrong → sharpen prompt / rerank / presentation

For every miss this prints the full chain (qgen queries, CRAG gate decision, retrieved context + cosine
scores, vote share, final answer). With --judge, an LLM attribution pass reads the retrieved context and
decides whether the correct answer was derivable from it, giving the retrieval-vs-generation split.

Usage:
  board-misses.py --ckpt board.jsonl --arm brain [--vs baseline] [--only-regressions] [--judge] [--limit N]
  (ANTHROPIC_API_KEY required for --judge)
"""
import argparse, json, os, sys, textwrap, urllib.request

def wrap(s, w=84, ind='        '):
    return textwrap.fill(s.strip(), w, initial_indent=ind, subsequent_indent=ind)

def judge_retrieval(question, choices, gold, ctx_texts):
    """LLM attribution: is the correct answer DERIVABLE from the retrieved context alone?"""
    key = os.environ.get('ANTHROPIC_API_KEY', '')
    if not key or not ctx_texts:
        return None
    gold_txt = choices[ord(gold) - 65] if gold and gold.isalpha() and ord(gold) - 65 < len(choices) else gold
    ctx = "\n\n".join(f"[{i+1}] {t}" for i, t in enumerate(ctx_texts))
    prompt = (
        f"Question: {question}\nChoices: {', '.join(f'{chr(65+i)}. {c}' for i,c in enumerate(choices))}\n"
        f"Correct answer: {gold}. {gold_txt}\n\nRetrieved context:\n{ctx}\n\n"
        "Does the retrieved context above contain the specific information needed to derive the CORRECT answer "
        "(not merely the right topic)? Reply exactly one word: DERIVABLE (the fact is present) or ABSENT (the "
        "context is on-topic but does not contain what's needed)."
    )
    body = json.dumps({"model": "claude-opus-4-8", "max_tokens": 8,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=60).read())
        out = "".join(b.get("text", "") for b in d.get("content", [])).strip().upper()
        return "GENERATION" if out.startswith("DERIV") else "RETRIEVAL"
    except Exception as e:
        print(f"  [judge error: {e}]", file=sys.stderr)
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--arm', default='brain')
    ap.add_argument('--vs', default='baseline')
    ap.add_argument('--only-regressions', action='store_true', help='only where --vs got it RIGHT but --arm wrong')
    ap.add_argument('--judge', action='store_true', help='LLM retrieval-vs-generation attribution (needs API key)')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(a.ckpt) if l.strip()]
    A, V = a.arm, a.vs
    misses = [r for r in rows if r.get(f'{A}_ok') is False]
    if a.only_regressions:
        misses = [r for r in misses if r.get(f'{V}_ok') is True]

    reg = sum(1 for r in rows if r.get(f'{A}_ok') is False and r.get(f'{V}_ok') is True)
    fixed = sum(1 for r in rows if r.get(f'{A}_ok') is True and r.get(f'{V}_ok') is False)
    print(f"# {A} vs {V} over {len(rows)} questions — {A} broke {reg} that {V} got right, fixed {fixed} that {V} missed")
    print(f"# showing {len(misses)}{' regressions' if a.only_regressions else f' {A} misses'}"
          + ("  (with retrieval-vs-generation attribution)" if a.judge else "") + "\n")

    tally = {'RETRIEVAL': 0, 'GENERATION': 0, 'NO-CTX': 0}
    for i, r in enumerate(misses):
        if a.limit and i >= a.limit:
            print(f"... (+{len(misses)-a.limit} more)"); break
        q, ch = r.get('question', '?'), r.get('choices', [])
        gold, pred = r.get('gold', '?'), r.get(f'{A}_pred', '?')
        ctx = r.get('brain_ctx') or []
        attribution = None
        if a.judge:
            attribution = judge_retrieval(q, ch, gold, [h.get('text', '') for h in ctx]) if ctx else 'NO-CTX'
            tally[attribution] = tally.get(attribution, 0) + 1

        print("═" * 90)
        tag = f"  ⟨{attribution} FAILURE⟩" if attribution else ""
        print(f"[{r.get('subject','?')}] type={r.get('ktype',['?'])}  gold={gold}  {A}={pred}✗  {V}={r.get(f'{V}_pred','?')}"
              f"{'✓' if r.get(f'{V}_ok') else '✗'}  retr-conf={r.get('brain_conf','?')}{tag}")
        print(wrap(q, 86, '  Q: '))
        for j, c in enumerate(ch):
            mark = '←gold' if chr(65+j) == gold else ('←picked' if chr(65+j) == pred else '')
            print(f"     {chr(65+j)}. {c} {mark}")
        # ── the chain ──
        if r.get('qgen'):
            print("  CHAIN · query-gen (HyDE/step-back):")
            for qq in r['qgen'][:3]: print(wrap(str(qq), 84, '        · '))
        if r.get(f'{A}_mode') or r.get('gate_decision'):
            print(f"  CHAIN · arm mode: {r.get(f'{A}_mode','?')}   gate_decision={r.get('gate_decision','—')} "
                  f"(conf {r.get('gate_conf','—')})   vote={r.get('vote_share','—')}")
        if ctx:
            print("  CHAIN · retrieved context (what the model actually saw):")
            for k, h in enumerate(ctx):
                print(f"    [{k+1}] {h.get('slug','?')} · {h.get('material','?')} · cos={h.get('score','?')}")
                print(wrap(h.get('text', ''), 84))
        else:
            print("  CHAIN · retrieved context: <none — run board with MMLU_CAPTURE_CTX=1>")
        print()

    if a.judge and misses:
        print("═" * 90)
        print(f"ATTRIBUTION SUMMARY over {sum(tally.values())} misses:")
        for k in ('RETRIEVAL', 'GENERATION', 'NO-CTX'):
            n = tally.get(k, 0)
            if n: print(f"  {k:12} {n:4}  ({100*n/sum(tally.values()):.0f}%)  → "
                        + {'RETRIEVAL': 'sharpen vector retrieval / query-gen',
                           'GENERATION': 'sharpen prompt / rerank / context presentation',
                           'NO-CTX': 'no context retrieved (gate skipped or no corpus)'}[k])

if __name__ == '__main__':
    main()
