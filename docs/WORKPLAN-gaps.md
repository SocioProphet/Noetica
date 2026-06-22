# Noetica gap work-plan (2026-06-22)

Enumerated gaps from outside-in research sweeps + the user's specific callouts (graph DB, UI, ontology
integration). Ordered by leverage. "Implemented" = landed in code; "Planned" = scoped, not yet built.

## A. Ontology integration (ontogenesis / GAIA) — IN PROGRESS
The canonical ontology lives in `SocioProphet/ontogenesis` (180 TTL, SHACL shapes, JSON-LD `@context`,
Domains: investigation/fraud/cyber/human/…) and `SocioProphet/prophet-domain-gaia-ontology`
(gaia world-signals: `gaia: <https://schemas.socioprophet.org/gaia/>` — FeatureRegistryEntry, ConcordanceLink,
CanonicalEntity, PromotionState{EvidenceOnly,ReviewRequired,Rejected,Promoted}).
- ✅ `lib/gaia-bridge.ts` — emit Noetica places→FeatureRegistryEntry, entity-resolution→ConcordanceLink,
  concepts→CanonicalEntity as CONFORMANT GAIA JSON-LD with the real namespace; verification→PromotionState;
  SHACL-required-prop conformance check. Endpoint `/api/cap/gaia-export`.
- ☐ Planned: load the actual TTL/SHACL from the repos (vendored) and run full SHACL validation (not just
  required-prop lite); emit ProphetArtifact envelopes (provenance/policy/evidence) like
  `examples/prophet-artifact-gaia-bounded-osm-ingest.example.jsonld`; map our OFIF/geo ingest to the
  `gaia-osm-ingest` artifact actions (fetch/validate) + promotion gate `gaia_ingest_gate`.
- ☐ Planned: contribute Noetica's IOES mappings UPSTREAM (PR into ontogenesis Domains or regis-entity-graph).

## B. Graph DATABASE (HellGraph) SOTA gaps — vs Neo4j 5 / KuzuDB / Memgraph
HellGraph is AtomSpace-class (in-RAM, addNode/addEdge, SPARQL, no tx/index/planner). Most fixes are in the
HellGraph Rust core (`@socioprophet/hellgraph`), so they're work-plan items for that repo, with Noetica-layer
shims where possible.
1. ☐ **Native HNSW vector index in-store + graph-vector hybrid query** (HIGHEST leverage). Bind `usearch`/
   `hnsw_rs` in the Rust core, key by node id; `queryVectorIndex(vec,k)` → ids → traversal. Unlocks one-query
   GraphRAG. Noetica shim: a TS HNSW over noetica-embed vectors keyed to node ids (interim).
2. ☐ **Full-text (BM25) index** — embed Tantivy in the Rust core (what Memgraph did). Interim: our
   `lib/hybrid-retrieve.ts` BM25 already lands the lexical half.
3. ☐ **WAL persistence + crash recovery** — back the store with RocksDB/redb (Oxigraph's approach).
4. ☐ **ACID + MVCC** (version chains) — also the substrate for time-travel/as-of.
5. ☐ **Secondary/composite + primary-key hash indexes** — O(1) prop lookups vs allNodes-scan.
6. ☐ **Cost-based query planner + statistics**; align the sidecar to **openCypher**.
7. ☐ **Property constraints + schema** — interim: `lib/graph-shapes.ts` (SHACL-lite) validates writes.
8. ☐ **CDC / change-streams** — falls out of the WAL; feeds re-embedding + the audit lane.
Skip (contrary to embedded/sovereign design): sharding/replication, columnar rewrite, ISO-GQL badge.

## C. UI screens — vs Microsoft Foundry / IBM watsonx / Google Vertex
Noetica has chat + graph rail + sandbox + voice, but no AI-ops workbenches.
1. ☐ **Agent-trace viewer** (span tree) — HIGHEST leverage; the loop already emits the events. Substrate for 2/4/6.
2. ☐ **RAG-inspection / retrieval-debug screen** (chunks + scores + citations) — genuine whitespace; fuse with the graph.
3. ☐ **Prompt-engineering workbench** (variables, versions, side-by-side compare).
4. ☐ **Evaluation dashboard** (eval runs, metrics, regression compare) — closes the verifier→selection keystone.
5. ☐ **Model-comparison playground** (race the mesh tiers, local verifier adjudicates).
6. ☐ **Dataset / eval-set manager** (capture failing traces → regression set; `lib/eval-capture.ts` is the backend).
7. ☐ **Guardrail/safety config screen** (over scope-d/kill-switch/PII + `lib/trajectory-monitor.ts`/`egress-hygiene.ts`).
8. ☐ **Knowledge-base / index management** (sources, index health, re-index).

## D. Wiring backlog (the ~52 capability libs → live flows)
best-of-N+abstention→generate loop; rag-trust+injection-classifier+capability-egress→tool path; PPR+hybrid-
retrieve+RRF→retrieval; memory-decay+procedural-memory→`remember`; dreaming→idle job→verify→HellGraph; graph-
proposals accept/reject UI→write-back. (`/api/cap/*` exposes them standalone today; deep wiring is pending.)
