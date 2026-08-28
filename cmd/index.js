'use strict'

const process = require('bare-process')
const { bail, command, flag, summary } = require('paparam')
const client = require('./client')
const newLobby = require('./new-lobby')
const server = require('./server')
const pkg = require('../package.json')

const cli = command(
  'pear-speed',
  summary(pkg.description),
  flag('--lobby <z32-topic>', 'Topic to use'),
  flag('--version|-v', 'Show version'),
  bail(({ err, reason }) => onerror(err || reason)),
  command('new-lobby', summary('Generate a unique lobby topic'), newLobby),
  command(
    'server',
    summary('Volunteer bandwidth to pear-speed'),
    flag('--connections <count>', 'Concurrent test limit'),
    flag('--lobby <z32-topic>', 'Topic to use'),
    server
  ),
  client
)

module.exports = function main(argv = process.argv.slice(2)) {
  return cli.parse(argv)
}

function onerror(err) {
  console.error(err.message || err)
  Bare.exitCode = 1
}
