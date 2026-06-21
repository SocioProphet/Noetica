#!/usr/bin/env python3
"""
contamination_audit — the clean-eval certificate. Prove the brain has NO MMLU test text in it.

The whole "technique not horsepower" claim dies the instant a skeptic finds an MMLU question
sitting verbatim in an OCW chunk. MMLU draws on exam-style items and MIT OCW ships real exams, so
overlap is *possible* — we must rule it out, not assume it. This builds a small index of every
MMLU question's k-word shingles, then STREAMS the brain and flags any chunk that contains one
verbatim. A hit means the exact question (≥K consecutive words) appears in the brain → leakage to
review/exclude before the exam. Zero hits = a defensible clean-eval certificate.

Direction matters for memory: index the (small) questions, stream the (large) brain — so we never
hold the brain in RAM.

Run:  python3 scripts/contamination_audit.py [--k 12] [--fields physics,chemistry,...]
"""
import os, sys, json, glob, re

BRAIN = os.environ.get('OCW_BRAIN', os.path.expanduser('~/Downloads/MIT OCW/_brain'))
BANK = os.path.expanduser('~/.noetica/corpus/benchmarks/mmlu_stem.json')
K = int(sys.argv[sys.argv.index('--k') + 1]) if '--k' in sys.argv else 12  # verbatim run length (words)


def norm(t):
    return re.sub(r'[^a-z0-9 ]+', ' ', t.lower()).split()


def shingles(words, k=K):
    for i in range(len(words) - k + 1):
        yield ' '.join(words[i:i + k])


def main():
    bank = json.load(open(BANK))
    fields = None
    if '--fields' in sys.argv:
        fields = set(sys.argv[sys.argv.index('--fields') + 1].split(','))

    # index every MMLU question's shingles (question + its answer choices — the distinctive text)
    qshingle = {}  # shingle -> (subject, qi, preview)
    nq = 0
    for subj, qs in bank.items():
        for qi, q in enumerate(qs):
            nq += 1
            words = norm(q['question'] + ' ' + ' '.join(q.get('choices', [])))
            if len(words) < K:
                continue
            for sh in shingles(words):
                qshingle[sh] = (subj, qi, q['question'][:84])
    print(f'# indexed {nq} MMLU questions → {len(qshingle):,} distinctive {K}-grams to search for')

    files = []
    for d in sorted(os.listdir(BRAIN)):
        if fields and d not in fields:
            continue
        if os.path.isdir(os.path.join(BRAIN, d)):
            files += glob.glob(os.path.join(BRAIN, d, '*.jsonl'))

    flagged = {}      # (subject, qi) -> (preview, course)
    nchunks = 0
    for fp in files:
        course = os.path.basename(fp)[:-6]
        for line in open(fp, errors='replace'):
            line = line.strip()
            if not line:
                continue
            try:
                text = json.loads(line).get('text', '')
            except Exception:
                continue
            nchunks += 1
            words = norm(text)
            if len(words) < K:
                continue
            for sh in shingles(words):
                hit = qshingle.get(sh)
                if hit:
                    flagged[(hit[0], hit[1])] = (hit[2], course)

    print(f'# streamed {len(files)} courses · {nchunks:,} chunks')
    nflag = len(flagged)
    per = {}
    for (subj, _qi), (_prev, _c) in flagged.items():
        per[subj] = per.get(subj, 0) + 1
    if nflag == 0:
        print(f'\n# ✅ CLEAN — no MMLU question’s {K}-word span appears verbatim in the brain.')
        print('#    The open-book lift cannot be memorized answer-key leakage. Eval is defensible.')
        return
    print(f'\n# ⚠ {nflag}/{nq} questions have a verbatim {K}-gram in the brain — REVIEW before the exam:')
    for subj in sorted(per, key=lambda s: -per[s]):
        print(f'  {subj:30} {per[subj]}')
    print('\n# worst offenders (question → course it leaked from):')
    for (subj, qi), (prev, course) in list(flagged.items())[:8]:
        print(f'  [{subj}] “{prev}…”  ⟵  {course}')
    print('\n# Action: drop these chunks/courses from the brain (or raise --k if matches are generic).')


if __name__ == '__main__':
    main()
