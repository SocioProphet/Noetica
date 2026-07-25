# vendor/

Vendored third-party artifacts that are NOT available on the public npm registry.

## xlsx-0.20.3.tgz  (SheetJS)
The npm `xlsx` package is abandoned at 0.18.5, which carries CVE-2023-30533
(prototype pollution) and CVE-2024-22363 (ReDoS). SheetJS ships patched releases
only from their own CDN (https://cdn.sheetjs.com), not npm.

Rather than fetch from that CDN at build time (external dependency + drops the
package out of registry audit/mirroring), the patched tarball is committed here
and referenced via `"xlsx": "file:vendor/xlsx-0.20.3.tgz"` in package.json.

- Version: 0.20.3
- Source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- sha512: oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==

To update: download the new tarball from cdn.sheetjs.com, verify its sha512, drop
it here, bump the file: reference, and delete the old one.

## superconscious/schemas/interpretability/  (SocioProphet/superconscious)

The interpretability-harness governance schemas — `ProviderBinding`,
`ArtifactSourceLock`, `InterventionSpec`, `FeatureRegistryEntry`. Noetica is the
integration surface for interpretability evidence, so it must be able to validate that
evidence without requiring the `superconscious` repo to be checked out beside it.

Unlike the npm tarball above, these are vendored as plain JSON with an integrity
manifest rather than a packed archive, because they are read directly by validators in
several languages (the rig that produces this evidence is Python).

- Upstream: https://github.com/SocioProphet/superconscious
- Upstream path: `schemas/interpretability/`
- Pinned commit: `921973094645c9223c22a1b9f52ecf75c2ccf785`
- Integrity: `manifest.json` records a sha256 per file.

**Drift is the failure mode here, not absence.** A stale vendored schema validates
happily and silently certifies evidence against a contract that has since changed. So
`manifest.json` is not decoration: `noetica-impair`'s conformance tests recompute every
sha256 and FAIL on divergence from upstream when the superconscious repo is present.

To update: re-copy from upstream, regenerate `manifest.json` (sha256 per file + the new
`upstream_commit`), and re-run the noetica-impair conformance suite before committing.
