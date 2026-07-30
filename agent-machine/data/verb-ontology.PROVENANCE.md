# Verb ontology — provenance

## KKO upper classes used

The `kkoClass` values in `verb-ontology.json` reference the KBpedia Knowledge
Ontology (KKO), an open Peircean upper ontology. The KKO source lives in the
estate at `~/dev/hellgraph/ontology/kko/kko-2.10.n3`; upstream is
https://kbpedia.org/.

The upper classes referenced here, in KKO's own dotted notation:

| kkoClass                | KKO parent                        | why it's the right anchor |
|-------------------------|-----------------------------------|---------------------------|
| `Events.Observation`    | `Events ⊑ Particulars`            | pure inspection — the subject is not modified by the act of observing |
| `InquiryMethods`        | `InquiryMethods ⊑ Methodeutic`    | methods for testing facts and organizing inquiry — search, measure, reason, adjudicate |
| `Action`                | `Action ⊑ Events`                 | *"modification of things is more prominent than reaction to it"* — the workhorse for state-changing verbs |
| `Situations`            | `Situations ⊑ States`             | verbs that change the *state* of an entity rather than its content — open, close |
| `SituationTypes`        | `SituationTypes ⊑ MediativeRelations` | scheduling / capability enablement — mediate a future situation |
| `TriadicAction`         | `TriadicAction ⊑ Continuous`      | *"one event, A, produces a second event, B, that is a means to the production of a third"* — send, publish, subscribe, invite, share, acknowledge |
| `LearningProcesses`     | `LearningProcesses ⊑ ConceptualSystems` | acquiring/modifying/reinforcing knowledge |
| `Processes`             | `Processes ⊑ Continuous`          | multi-step activities whose reversibility is contingent on their internals |

## Why we anchor here and not in Apple's vocabulary

Apple's `AppIntentSchemas.sqlite` exposes 203 intents with **four** semantic verbs
(`open`, `delete`, `search`, `audioStarting`); **156 of the 203 intents carry no
verb at all**. That is not a small classification — it is an absence. A system with
no verb ontology cannot say why two actions are the same kind of thing.

KKO gives us:

- an upper structure old enough to be scrutinised (Peirce's semiotics),
- a `TriadicAction` class that captures exactly the mediated-communication shape
  most agent verbs need (send / publish / invite / share),
- a distinction between *content-mutating* Actions and *state-transitioning*
  Situations that Apple has no vocabulary for,
- an `InquiryMethods` root that classifies adjudication verbs (approve, reject,
  reason, abstain) alongside the retrieval verbs (search, measure) that
  interrogate them.

## Not carried

- **kkoClass is a leaf name, not a URI.** We deliberately do not carry the full
  `http://kbpedia.org/ontologies/kko#TriadicAction` URI at every reference site
  because the upstream base can change; the leaf name plus the pinned
  `kkoVersion` in the ontology header does the same job for tracing without
  making every consumer parse RDF.
- **Peirce's Firstness/Secondness/Thirdness triad** is used implicitly by KKO's
  own class hierarchy; it is *not* reproduced as a top-level field on each verb.
  Anyone who needs it can look up the KKO parent chain of the referenced class.
