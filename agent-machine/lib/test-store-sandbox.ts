/**
 * test-store-sandbox — preloaded by `npm test` (see the `--import` in package.json) so that NO test
 * process can reach the operator's real ~/.noetica.
 *
 * WHY A PRELOAD AND NOT A HOOK IN EACH TEST FILE. The hazard is that a path resolves before a test can
 * redirect it. A `before()` hook runs AFTER the module graph has loaded, which is exactly how
 * open-chat-index.test.ts's `process.env.HOME` sandbox silently missed. `--import` runs before ANY test
 * module is evaluated, in every test child process, so the overrides are in place first — and that
 * ordering is a property of the runner rather than of 232 test files remembering to do it.
 *
 * WHY NOT MOVE $HOME. os.homedir() honours $HOME, so moving it looks like it works — but it is a blunt
 * instrument that also redirects everything else that reads the home directory, and it cannot be
 * verified, because the assertion that would check it also reads $HOME. The per-store overrides below
 * are explicit, and lib/store-path-guard.test.ts checks them against `os.userInfo().homedir`, which
 * comes from the passwd database and cannot be spoofed by a moved $HOME.
 *
 * This is the SECOND half of the fix. Making a module resolve its path late does not by itself redirect
 * anything — it only makes redirection POSSIBLE. Converting the modules without this preload left the
 * suite still writing collections.json and routing-decisions.jsonl, because "late" still resolves to
 * production when nothing sets an override.
 *
 * Set NOETICA_TEST_SANDBOX=0 to opt out (e.g. to reproduce a bug against real data on purpose).
 * Any override already present in the environment is respected, never clobbered.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

if (process.env['NOETICA_TEST_SANDBOX'] !== '0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `noetica-test-${process.pid}-`))

  /** env var → path beneath the sandbox root. Keep in step with CONVERTED in store-path-guard.test.ts. */
  const overrides: Record<string, string> = {
    // Sovereign identity + crypto material. A stray write here is not lossy, it is key loss.
    NOETICA_AT_REST_KEY: path.join(root, 'at-rest.key'),
    NOETICA_SOVEREIGN_ROOT: path.join(root, 'sovereign-root.key'),
    NOETICA_AUDIT_KEY_DIR: path.join(root, 'audit'),
    NOETICA_IDENTITY_STORE: path.join(root, 'identity.json'),
    // Governance / evidence.
    NOETICA_A2A_STORE: path.join(root, 'a2a-trust.json'),
    NOETICA_PROOFS_DIR: path.join(root, 'proofs'),
    NOETICA_PRIVACY_POLICY: path.join(root, 'privacy-policy.json'),
    SCOPED_EVENTS: path.join(root, 'scope-d', 'events.jsonl'),
    // User data + caches.
    NOETICA_COLLECTIONS_STORE: path.join(root, 'collections.json'),
    NOETICA_OPEN_CHATS_STORE: path.join(root, 'open-chats.json'),
    NOETICA_AGENT_RUNS_STORE: path.join(root, 'agent-runs.json'),
    NOETICA_ROUTINES_STORE: path.join(root, 'routines.json'),
    NOETICA_CONCEPTS_DIR: path.join(root, 'concepts'),
    NOETICA_GRAPH_REPLICA_STORE: path.join(root, 'graph-replica.json'),
    NOETICA_GRAPH_CLUSTER_CACHE_DIR: path.join(root, 'cache'),
    NOETICA_SELF_MODEL_STORE: path.join(root, 'self-model.json'),
    NOETICA_SOLUTION_MEMORY_DIR: path.join(root, 'solution-memory'),
    NOETICA_ROUTING_LOG_PATH: path.join(root, 'routing-decisions.jsonl'),
    NOETICA_OCR_BIN_DIR: path.join(root, 'bin'),
    // The exhaust plane resolves lazily through noeticaHome() rather than a frozen constant, so it was
    // never part of the module-load-constant class — but it still wrote the real files, because nothing
    // set its override either. Same second-half gap, different mechanism.
    NOETICA_HOME: root,
  }

  for (const [k, v] of Object.entries(overrides)) if (process.env[k] === undefined) process.env[k] = v

  process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } })
}
