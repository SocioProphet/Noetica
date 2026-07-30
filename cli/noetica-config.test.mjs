import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveStartServer, PRODUCTION_BUILD_MARKER } from './noetica-config.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

test('noetica start serves the production build when one exists', () => {
  const r = resolveStartServer(true)
  assert.equal(r.npmScript, 'start')      // npm run start === next start (production)
  assert.equal(r.server, 'production')
})

test('noetica start falls back to the dev server when no build is present', () => {
  const r = resolveStartServer(false)
  assert.equal(r.npmScript, 'dev')
  assert.equal(r.server, 'development')
})

test('start and dev resolve to DIFFERENT servers (the bug this fixes)', () => {
  // The whole point: with a build, `start` must not be identical to `dev`.
  assert.notEqual(resolveStartServer(true).npmScript, resolveStartServer(false).npmScript)
})

test('the npm scripts the feature dispatches to actually exist', () => {
  // resolveStartServer returns 'start'/'dev'; both must be real package scripts or
  // the CLI would run `npm run <missing>` and fail at the worst moment.
  assert.ok(pkg.scripts?.start, 'package.json is missing a "start" script')
  assert.ok(pkg.scripts?.dev, 'package.json is missing a "dev" script')
  assert.ok(pkg.scripts?.build, 'package.json is missing a "build" script (needed for the production path)')
})

test('the production-build marker is Next\'s BUILD_ID', () => {
  assert.equal(PRODUCTION_BUILD_MARKER, '.next/BUILD_ID')
})
