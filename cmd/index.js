'use strict'

const process = require('bare-process')
const { bail, command, flag, summary } = require('paparam')
const peer = require('./peer')
const pkg = require('../package.json')

const cli = command(
  'pear-speed',
  summary(pkg.description),
  flag('--lobby <name>', 'Private lobby name'),
  flag('--version|-v', 'Show version'),
  bail(({ err, reason }) => onerror(err || reason)),
  peer
)

module.exports = function main(argv = process.argv.slice(2)) {
  return cli.parse(argv)
}

function onerror(err) {
  console.error(err.message || err)
  Bare.exitCode = 1
}
