'use strict'

const { style } = require('bare-tui')
const Server = require('../ops/server')
const { CONNECTIONS, MAX_PEERS } = require('../ops/constants')
const { DOWNLOAD, UPLOAD } = require('./colors')
const parseTopic = require('./topic')

module.exports = async function server(cmd) {
  const connections =
    cmd.flags.connections === undefined ? CONNECTIONS : Number(cmd.flags.connections)
  if (!Number.isSafeInteger(connections) || connections < 1 || connections > MAX_PEERS) {
    throw new Error(`--connections must be an integer from 1 to ${MAX_PEERS}`)
  }

  const topic = cmd.flags.lobby === undefined ? undefined : parseTopic(cmd.flags.lobby)
  const op = new Server(connections, topic)
  op.on('listening', ({ port }) => {
    console.log(
      `${style().foreground('white').render('Port:')} ${style().foreground('gray').render(port)}`
    )
    console.log(
      `${style().foreground('white').render('Lobby:')} ${style()
        .foreground('gray')
        .render(cmd.flags.lobby || 'PUBLIC')}`
    )
  })
  op.on('announced', () => {
    console.log(style().foreground(DOWNLOAD).render('Server is running!'))
  })
  op.on('result', ({ ip, port, sent, received }) => {
    const host = ip.includes(':') ? `[${ip}]` : ip
    const peer =
      style().foreground('white').render(host) +
      (port ? style().foreground('gray').render(`:${port}`.padEnd(6)) : '')
    const download = style()
      .foreground(DOWNLOAD)
      .render(`↓ ${formatSize(sent)}`)
    const upload = style()
      .foreground(UPLOAD)
      .render(`↑ ${formatSize(received)}`)
    console.log(`${peer}  ${download}  ${upload}`)
  })
  op.on('close', () => {
    console.log('\n' + style().foreground('gray').render('pear-speed server stopped'))
  })
  await op.run()
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
