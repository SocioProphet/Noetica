# Research → Product Gap Backlog (the loop)

**The loop (operating mode):** investigate gaps → survey labs/papers/competitors → prioritize gaps →
implement → measure → **repeat**. Each pass adds rows here, ships the top ones, re-surveys.

## Banked wins
- 🏆 **Council champion = 71.7%** — top arm on qwen2.5:7b (baseline 69.2, brain 70.0). Integration is sound.
- ✅ **Self-consistency** (`askVote`) — Google 2022. In production (the council vote).
- ✅ **VSA / NVSA substrate** (`vsa.py`) — IBM Nature MI 2023. HRR bind/unbind/bundle/permute + cleanup, validated. The vector↔symbolic bridge.

## In flight (GPU)
- 🔄 **Track A** — definitive board (`baseline·brain·champion·gate·autoform`, 7 lanes, n=30, 432K brain). → does it clear 74.2%?
- 🔄 **Track B** — concept-extraction glossary over all 7 fields (GLiNER on T4).

## Backlog — prioritized (lab · paper · what it gives us · status)

| P | Gap | Lab · paper | Gives us | Status |
|---|-----|-------------|----------|--------|
| 1 | **Contextual Retrieval — hybrid BM25 + RRF** | Anthropic 2024 | catches exact-term matches dense misses | ✅ `MMLU_HYBRID` (full contextual-embeddings re-embed = GPU upgrade) |
| 1 | **VSA problem-manipulation** (concept compose, CBR structure-match, abductive MCQ) | IBM NVSA | manipulate problems algebraically in vector space | substrate built → apply |
| 2 | **CISC** (confidence-weighted SC) | Google 2025 | 40% fewer samples, +acc on the council vote | ✅ `MMLU_CISC` |
| 2 | **Self-Discover routing** | DeepMind NeurIPS'24 | learned per-type reasoning structure (replaces hand-coded knowledge_type) | backlog |
| 2 | **Least-to-Most decomposition** | Google | subproblem decomposition for math/compositional lanes | backlog |
| 2 | **Gödel-abstraction arm** | (ours + abstraction lit) | lift problem to its canonical form, solve the form | backlog |
| 3 | **FunSearch combiner** | DeepMind Nature'23 | LLM-proposes-programs + evaluator → discover the council law (upgrade gplearn) | backlog |
| 3 | **CBR / analogical** | C²P 2024 | retrieve structurally-similar SOLVED problem, transfer reasoning | backlog |
| 3 | **Process-supervision verifier (PRM)** | OpenAI 2023 | step-level (not outcome) scoring — replaces failed elim | backlog |
| 3 | **Tree-of-Thoughts search** | Princeton/DeepMind | deliberate search+backtrack for hard lanes (Game-of-24 4%→74%) | backlog |
| 4 | **HippoRAG concept graph + PPR** | OSU NeurIPS'24 | graph retrieval; blocked on extractor speed (Track B unblocks) | infra built |
| 4 | **RAPTOR summaries** | Stanford ICLR'24 | hierarchical summary nodes; fixes 6/8 redundancy | subagent |
| 4 | **Entity-linking glossary v2** | Meta GENRE/BLINK + SciSpacy UMLS | canonical IDs (Wikidata/UMLS/MeSH/MSC) — dedup+interop moat | backlog |
| 5 | **Joint retriever-LM** | Meta Atlas | train retriever with LM (we use frozen) — the thesis anchor | research |
| 5 | **Autoform NL→formal + checker-as-reward** | DeepMind AlphaProof | strengthen the compute spine | partial (autoform abstains) |
| 5 | **LNN neurosymbolic operations layer** | IBM LNN/NSQA | NL→logical form → reason over KB | research |

## Retired
- ❌ **elim** (Monty-Hall per-choice) — 45%, below random on stats. Outcome-level verify fails; PRM is the fix.

## Loop cadence
After each implement+measure pass: append new gaps, re-rank, re-survey for what the field shipped since. Keep `[[project_mmlu_championship]]` memory + this file in sync.
