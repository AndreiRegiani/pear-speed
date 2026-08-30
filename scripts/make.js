#!/usr/bin/env bare

'use strict'

const env = require('bare-env')
const os = require('bare-os')
const { spawn } = require('bare-subprocess')

const host = env.HOST || `${os.platform()}-${os.arch()}`
const supported = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
]

if (!supported.includes(host)) {
  console.error(`Unsupported host: ${host}`)
  Bare.exitCode = 1
} else {
  const child = spawn(
    'bare-build',
    ['--name', 'pear-speed', '--standalone', '--host', host, '--out', `./out/${host}`, 'bin.mjs'],
    { stdio: 'inherit' }
  )
  child.on('error', (err) => {
    console.error(err)
    Bare.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    Bare.exitCode = signal ? 1 : code
  })
}
