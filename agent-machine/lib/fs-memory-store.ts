/**
 * fs-memory-store.ts — a filesystem MemoryStore for the Claude-pattern layered memory.
 *
 * Realizes the living-KB on disk (Karpathy pattern), matching how Claude Code's own memory is laid out:
 *   L1  <root>/MEMORY.md          — the always-loaded index (one pointer line per topic)
 *   L2  <root>/topics/<name>.md   — on-demand topic docs, frontmatter (links/score/provenance) + body
 *   L3  <root>/transcripts/log.jsonl — append-only, grep-only
 *
 * A `namespace` scopes the root (e.g. local vs shared) — the seam the isolation model plugs into later.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { MemoryStore, MemoryPointer, TopicDoc } from './memory-layers.js'
// Encrypted at rest: topic bodies ("what it learned") and transcripts contain user content and must not
// sit in cleartext. decryptText reads legacy plaintext verbatim, so this migrates losslessly. The
// MEMORY.md index stays plaintext — it is pointers/hooks only, no substantive content.
import { encryptText, decryptText } from './at-rest.js'

/**
 * A namespace names ONE directory under the memory root. It is NOT a path, and it is
 * not free text: `GET /api/memory/bands` serves it straight off a query parameter, so
 * an unconfined value here is a directory-traversal primitive rather than a seam —
 * `?namespace=../../../../etc` used to resolve to `/etc` and enumerate `/etc/topics`.
 *
 * Confinement lives here rather than at the handler because this is the seam every
 * caller crosses. Fixing only the one exposed route would leave the next caller to
 * rediscover the same hole; `path.join` collapses `..` silently and will never say no.
 */
const NAMESPACE_SEGMENT = /^[A-Za-z0-9_.-]+$/

export function memoryRoot(namespace = 'default'): string {
  const base = process.env.NOETICA_MEMORY_DIR || path.join(os.homedir(), '.noetica', 'memory')
  if (namespace === 'default') return path.resolve(base)

  // A single safe segment, and never a dots-only one (`.`/`..` match the charset).
  if (!NAMESPACE_SEGMENT.test(namespace) || /^\.+$/.test(namespace)) {
    throw new Error(`invalid memory namespace ${JSON.stringify(namespace)}: expected a single path segment`)
  }
  const root = path.resolve(base, namespace)
  const confined = path.resolve(base)
  // Belt and braces: the charset above already excludes separators, but the
  // containment assertion is what actually states the guarantee.
  //
  // Via path.relative rather than `startsWith(confined + path.sep)`: when the base
  // IS a filesystem root, that prefix doubles the separator ("/" + "/" = "//") and
  // the check rejects the legitimate "/self". NOETICA_MEMORY_DIR="/" is a strange
  // thing to set, but a confinement check that fails closed on valid input is still
  // a broken check, and the Windows drive-root case ("C:\" + "\") has the same shape.
  const rel = path.relative(confined, root)
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
    throw new Error(`invalid memory namespace ${JSON.stringify(namespace)}: escapes the memory root`)
  }
  return root
}

const safeName = (name: string) => name.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_')

// ── topic (.md) serialize / parse ──
function serializeTopic(d: TopicDoc): string {
  const fm = ['---', `name: ${d.name}`, `updatedAt: ${d.updatedAt}`]
  if (d.score != null) fm.push(`score: ${d.score}`)
  if (d.provenance) fm.push(`provenance: ${d.provenance}`)
  fm.push(`links: [${d.links.join(', ')}]`, '---', '')
  return fm.join('\n') + (d.body.endsWith('\n') ? d.body : d.body + '\n')
}

function parseTopic(fallbackName: string, raw: string): TopicDoc {
  let body = raw
  const meta: Record<string, string> = {}
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (m) {
    body = raw.slice(m[0].length)
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/)
      if (kv) meta[kv[1]] = kv[2]
    }
  }
  const fmLinks = (meta.links ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
  // living-KB: also treat [[name]] wikilinks in the body as backlinks
  const bodyLinks = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1].trim())
  return {
    name: meta.name || fallbackName,
    body,
    links: [...new Set([...fmLinks, ...bodyLinks])],
    score: meta.score != null ? Number(meta.score) : undefined,
    provenance: meta.provenance || undefined,
    updatedAt: meta.updatedAt != null ? Number(meta.updatedAt) : 0,
  }
}

const firstLine = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').slice(0, 140)

export function fsMemoryStore(namespace = 'default'): MemoryStore {
  const root = memoryRoot(namespace)
  const topicsDir = path.join(root, 'topics')
  const transcript = path.join(root, 'transcripts', 'log.jsonl')
  const indexFile = path.join(root, 'MEMORY.md')
  const topicPath = (name: string) => path.join(topicsDir, `${safeName(name)}.md`)

  const ensure = async () => {
    await fs.mkdir(topicsDir, { recursive: true })
    await fs.mkdir(path.dirname(transcript), { recursive: true })
  }

  return {
    async readIndex(): Promise<MemoryPointer[]> {
      const raw = await fs.readFile(indexFile, 'utf8').catch(() => '')
      const ptrs: MemoryPointer[] = []
      for (const line of raw.split('\n')) {
        const m = line.match(/^- \[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)$/)
        if (m) ptrs.push({ name: m[1], topic: m[2], hook: m[3] })
      }
      return ptrs
    },
    async writeIndex(ptrs: MemoryPointer[]): Promise<void> {
      await ensure()
      const body = '# Memory Index\n' + ptrs.map((p) => `- [${p.name}](${p.topic}) — ${p.hook}`).join('\n') + '\n'
      await fs.writeFile(indexFile, body)
    },
    async listTopics(): Promise<string[]> {
      const files = await fs.readdir(topicsDir).catch(() => [] as string[])
      return files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    },
    async readTopic(name: string): Promise<TopicDoc | null> {
      const raw = await fs.readFile(topicPath(name), 'utf8').catch(() => null)
      return raw == null ? null : parseTopic(safeName(name), decryptText(raw))
    },
    async writeTopic(doc: TopicDoc): Promise<void> {
      await ensure()
      await fs.writeFile(topicPath(doc.name), encryptText(serializeTopic(doc)))
    },
    async deleteTopic(name: string): Promise<void> {
      await fs.rm(topicPath(name), { force: true })
    },
    async grepTranscripts(query: string): Promise<string[]> {
      const raw = await fs.readFile(transcript, 'utf8').catch(() => '')
      // Decrypt each stored line (enc: or legacy plaintext) before matching + returning.
      return raw.split('\n').map(decryptText).filter((l) => l && l.includes(query))
    },
    async appendTranscript(line: string): Promise<void> {
      await ensure()
      await fs.appendFile(transcript, encryptText(line.replace(/\n/g, ' ')) + '\n')
    },
  }
}

export { firstLine as _firstLine }
