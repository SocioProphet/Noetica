#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(__filename), '..')
const packagePath = join(repoRoot, 'package.json')
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))

const command = process.argv[2] ?? 'help'
const args = process.argv.slice(3)

const commands = new Map([
  ['help', help],
  ['version', version],
  ['doctor', doctor],
  ['configure', configure],
  ['start', start],
  ['open', openNoetica],
  ['smoke', smoke],
  ['service', service],
])

const handler = commands.get(command)

if (!handler) {
  console.error(`Unknown command: ${command}`)
  help()
  process.exit(2)
}

await handler(args)

function help() {
  console.log(`Noetica workstation CLI

Usage:
  noetica <command> [options]

Commands:
  version              Print version and installation metadata
  doctor [--json]      Report local readiness
  configure            Prepare user configuration (stub in Phase 1 Turn 2)
  start [-- ...]       Start Noetica in foreground mode
  open                 Open the configured local Noetica URL
  smoke [--dry-run]    Run a dry-run smoke check
  service <action>     OS-native service lifecycle command stubs

Service actions:
  install | start | status | stop | uninstall
`)
}

function version() {
  console.log(JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    private: packageJson.private === true,
    installRoot: repoRoot,
    phase: 'phase-1-cli-lifecycle',
  }, null, 2))
}

function doctor(args = []) {
  const json = args.includes('--json')
  const checks = [
    check('package_json', existsSync(packagePath), packagePath),
    check('next_config', existsSync(join(repoRoot, 'next.config.js')) || existsSync(join(repoRoot, 'next.config.mjs')), 'optional'),
    check('app_directory', existsSync(join(repoRoot, 'app')), join(repoRoot, 'app')),
    check('agent_machine', commandExists('agent-machine'), 'optional in Phase 1'),
    check('prophet_mesh', false, 'deferred in Phase 1'),
  ]

  const result = {
    kind: 'NoeticaDoctor',
    status: checks.every((candidate) => candidate.required !== true || candidate.ok) ? 'ok' : 'degraded',
    phase: 'phase-1-cli-lifecycle',
    checks,
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('Noetica doctor')
  console.log(`status: ${result.status}`)
  for (const item of checks) {
    const marker = item.ok ? 'ok' : item.required ? 'missing' : 'not_configured'
    console.log(`- ${item.name}: ${marker} (${item.detail})`)
  }
}

function configure() {
  console.log('Noetica configure is reserved for Phase 1 Turn 3.')
  console.log('Target config path: ~/.config/sourceos/noetica/config.json')
  console.log('No config was written by this skeleton command.')
}

async function start(args = []) {
  const nextArgs = args[0] === '--' ? args.slice(1) : args
  await run('npm', ['run', 'dev', '--', ...nextArgs], { cwd: repoRoot })
}

async function openNoetica() {
  const url = process.env.NOETICA_URL ?? 'http://127.0.0.1:3000'
  const platform = process.platform

  if (platform === 'darwin') {
    await run('open', [url])
    return
  }

  if (platform === 'linux') {
    await run('xdg-open', [url])
    return
  }

  console.log(url)
}

function smoke(args = []) {
  const dryRun = args.length === 0 || args.includes('--dry-run')
  if (!dryRun) {
    console.error('Only --dry-run smoke is implemented in Phase 1 Turn 2.')
    process.exit(2)
  }

  console.log(JSON.stringify({
    kind: 'NoeticaSmoke',
    mode: 'dry_run',
    status: 'ok',
    checks: [
      { name: 'cli_loaded', ok: true },
      { name: 'package_json', ok: existsSync(packagePath) },
    ],
  }, null, 2))
}

function service(args = []) {
  const action = args[0]
  const valid = new Set(['install', 'start', 'status', 'stop', 'uninstall'])

  if (!valid.has(action)) {
    console.error('Usage: noetica service <install|start|status|stop|uninstall>')
    process.exit(2)
  }

  console.log(JSON.stringify({
    kind: 'NoeticaServiceCommand',
    action,
    status: 'not_implemented',
    reason: 'OS-native service adapters are reserved for Phase 1 Turn 6.',
    expectedBackends: {
      darwin: 'launchctl LaunchAgent',
      linux: 'systemd --user or SourceOS-compatible user service',
    },
  }, null, 2))
}

function check(name, ok, detail, required = false) {
  return { name, ok, detail, required }
}

function commandExists(name) {
  const pathVar = process.env.PATH ?? ''
  const segments = pathVar.split(process.platform === 'win32' ? ';' : ':')
  return segments.some((segment) => existsSync(join(segment, name)))
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} exited with code ${code}`))
    })
  })
}
