#!/usr/bin/env bare

import process from 'bare-process'
import path from 'bare-path'
import os from 'bare-os'
import { persistent } from 'bare-storage'
import { isWindows } from 'which-runtime'
import pkg from './package.json'
import App from './app.js'
import main from './cmd/index.js'

const isDev = path.basename(process.argv[0]) === (isWindows ? 'bare.exe' : 'bare')
const raw = process.argv.slice(isDev ? 2 : 1)
const runtime = parseRuntime(raw)
const terminal =
  runtime.args.includes('--help') ||
  runtime.args.includes('-h') ||
  runtime.args.includes('--version') ||
  runtime.args.includes('-v')
const updates =
  runtime.updates === true ||
  (runtime.updates !== false && !isDev && !pkg.upgrade.includes('<YOUR_KEY_HERE'))

if (!updates || terminal) {
  await main(runtime.args)
} else {
  const dir = runtime.storage || path.join(persistent(), pkg.name)
  const app = new App({
    dir,
    updates: true,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name: isWindows ? `${pkg.name}.exe` : pkg.name,
    app: os.execPath()
  })
  process.on('SIGINT', () => app.exit(130))
  process.on('SIGTERM', () => app.exit(143))
  try {
    await app.ready()
    await main(runtime.args)
  } finally {
    await app.close()
  }
}

function parseRuntime(args) {
  const appArgs = []
  let updates = null
  let storage = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-updates') updates = false
    else if (arg === '--updates') updates = true
    else if (arg === '--storage') storage = args[++i]
    else if (arg.startsWith('--storage=')) storage = arg.slice(10)
    else appArgs.push(arg)
  }
  return { args: appArgs, updates, storage }
}
