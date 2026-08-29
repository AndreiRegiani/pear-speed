'use strict'

const tty = require('bare-tty')
const { Program, key, progress, quit, spinner, style, table } = require('bare-tui')
const Client = require('../ops/client')
const { PEERS, DURATION, PHASE_DURATION } = require('../ops/constants')
const { DOWNLOAD, UPLOAD } = require('./colors')
const parseTopic = require('./topic')
const pkg = require('../package.json')

const LATENCY = '#C792EA'
const BORDER = 'gray'
const DOWNLOAD_BAR = ['#007A5A', DOWNLOAD]
const UPLOAD_BAR = ['#315F9F', UPLOAD]

module.exports = async function client(cmd) {
  if (cmd.flags.version) {
    console.log(`pear-speed v${pkg.version}`)
    return
  }

  const topic = cmd.flags.lobby === undefined ? undefined : parseTopic(cmd.flags.lobby)
  const lobby = cmd.flags.lobby || 'PUBLIC'
  const op = new Client(PEERS, topic)

  if (tty.isTTY(0) && tty.isTTY(1)) {
    await runTui(op, lobby)
    return
  }

  console.log(`Finding ${PEERS} peers...`)
  const result = await op.run()
  printResults(result)
}

class ClientModel {
  constructor(op, lobby) {
    this.op = op
    this.lobby = lobby
    this.peerLimit = op.peerLimit
    this.snapshot = { phase: 'finding', elapsed: 0, peerLimit: op.peerLimit, peers: [] }
    this.result = null
    this.error = null
    this.exiting = false
    this.compact = false
    this.narrow = false
    this.spinner = spinner.create({ frames: spinner.points, fps: 6 })
    this.bar = progress.create({
      width: 54,
      full: '━',
      empty: '━',
      gradient: DOWNLOAD_BAR
    })
    this.table = table.create({
      height: Math.min(this.peerLimit, 10)
    })
    this._resize(80, 24)
  }

  init() {
    return [
      this.spinner.init(),
      async () => {
        try {
          return { type: 'done', result: await this.op.run() }
        } catch (error) {
          return { type: 'error', error }
        }
      }
    ]
  }

  update(msg) {
    if (msg.type === 'resize') {
      this._resize(msg.width, msg.height)
      return [this, null]
    }

    if (msg.type === 'state') {
      this.snapshot = msg.snapshot
      this._rows()
      return [this, null]
    }

    if (msg.type === 'spinner.tick') {
      const [spinner, cmd] = this.spinner.update(msg)
      this.spinner = spinner
      return [this, this.result || this.error ? null : cmd]
    }

    if (msg.type === 'done') {
      this.result = msg.result
      this.snapshot.phase = 'done'
      this._rows()
      return this._quit()
    }

    if (msg.type === 'error') {
      this.error = msg.error
      return this._quit()
    }

    if (
      key.matches(msg, 'enter') &&
      this.snapshot.phase === 'finding' &&
      this.snapshot.peers.some((peer) => peer.ready)
    ) {
      this.op.forceStart()
      return [this, null]
    }

    if (key.matches(msg, 'q', 'ctrl+c')) return this._quit()

    return [this, null]
  }

  _quit() {
    if (this.exiting) return [this, null]
    this.exiting = true
    return [
      this,
      async () => {
        await this.op.destroy()
        return quit()
      }
    ]
  }

  _rows() {
    const downloadElapsed = Math.max(Math.min(this.snapshot.elapsed, PHASE_DURATION) / 1000, 0.1)
    const uploadElapsed = Math.max(
      Math.min(Math.max(this.snapshot.elapsed - PHASE_DURATION, 0), PHASE_DURATION) / 1000,
      0.1
    )
    const rows = this.snapshot.peers.map((peer) => {
      const row = [
        ` ${formatAddress(peer, true)}`,
        style().foreground(LATENCY).render(formatLatency(peer.latency)),
        style()
          .foreground(DOWNLOAD)
          .render(formatSpeed(peer.downloaded / downloadElapsed)),
        style()
          .foreground(UPLOAD)
          .render(formatSpeed(peer.uploaded / uploadElapsed))
      ]
      if (this.narrow) return [row[0], row[2], row[3]]
      return row
    })
    const empty = this.narrow ? [' -', '', ''] : [' -', '', '', '']
    while (rows.length < this.table.height) rows.push(empty)
    this.table.setRows(rows)
    this.table.cursor = -1
  }

  _resize(screenWidth = 80, screenHeight = 24) {
    const width = Math.max(36, Math.min(96, screenWidth - 4))
    const contentWidth = width - 5
    const ipWidth = Math.floor(contentWidth * 0.42) + 4
    const latencyWidth = Math.floor(contentWidth * 0.18)
    const downloadWidth = Math.floor(contentWidth * 0.2)
    const uploadWidth = contentWidth + 4 - ipWidth - latencyWidth - downloadWidth
    this.compact = width < 64
    this.narrow = width < 48
    this.bar.setWidth(Math.min(54, width))
    this.table.height = Math.max(1, Math.min(this.peerLimit, 10, screenHeight - 14))
    this.table.setColumns(
      this.narrow
        ? [
            { title: ' IP address', width: width - 22 },
            { title: '↓ Download', width: 10 },
            { title: '↑ Upload', width: 10 }
          ]
        : this.compact
          ? [
              { title: ' IP address', width: width - 33 },
              { title: 'Latency', width: 8 },
              { title: '↓ Download', width: 11 },
              { title: '↑ Upload', width: 11 }
            ]
          : [
              { title: ' IP address', width: ipWidth },
              { title: 'Latency', width: latencyWidth },
              { title: '↓ Download', width: downloadWidth },
              { title: '↑ Upload', width: uploadWidth }
            ]
    )
    this._rows()
  }

  view() {
    const title = style().bold(true).foreground(DOWNLOAD).render('🍐 PEAR SPEED')
    const subtitle = style().faint(true).render('P2P speed test')
    const lobby = `${style().foreground('white').render('Lobby:')} ${style().foreground('gray').render(this.lobby)}`
    const phase = this._phase()
    this.bar.gradient =
      this.snapshot.phase === 'finding' || this.snapshot.phase === 'download'
        ? DOWNLOAD_BAR
        : UPLOAD_BAR
    const progressView = this.bar.view(this.snapshot.elapsed / DURATION)
    const body = style()
      .margin(0, 0, 0, 2)
      .border(style.borders.rounded)
      .borderForeground(BORDER)
      .render(this.table.view())
    const resultView = this._resultView()

    return [
      '',
      `  ${title}  ${subtitle}`,
      '',
      `  ${lobby}`,
      body,
      '',
      `  ${phase}`,
      `  ${progressView}`,
      '',
      `  ${resultView}`,
      ...(this.exiting ? ['', ''] : [])
    ].join('\n')
  }

  _phase() {
    if (this.error) return style().foreground('red').render(this.error.message)
    if (this.snapshot.phase === 'finding') {
      const activity = style().foreground(DOWNLOAD).render(this.spinner.view())
      const ready = this.snapshot.peers.filter((peer) => peer.ready).length
      const count = `${style().foreground(DOWNLOAD).render(ready)}/${this.snapshot.peerLimit}`
      const start = ready
        ? `  ·  ${style().foreground('yellow').render('[ENTER] to force start')}`
        : ''
      return `${activity} Finding peers  ${count}${start}`
    }
    if (this.snapshot.phase === 'verifying') {
      const activity = style().foreground('yellow').render(this.spinner.view())
      return `${activity} Verifying results`
    }
    if (this.snapshot.phase === 'done') {
      return `Completed · ${this.snapshot.peers.length} ${this.snapshot.peers.length === 1 ? 'peer' : 'peers'}`
    }
    const upload = this.snapshot.phase === 'upload'
    const remaining = Math.max(0, Math.ceil((DURATION - this.snapshot.elapsed) / 1000))
    const direction = style()
      .foreground(upload ? UPLOAD : DOWNLOAD)
      .render(upload ? '↑ Upload' : '↓ Download')
    return `${direction} · ${this.snapshot.peers.length} peers · ${remaining}s remaining`
  }

  _resultView() {
    const label = style().faint(true).render('RESULT')
    if (this.result) {
      const download = style()
        .bold(true)
        .foreground(DOWNLOAD)
        .render('↓ ' + formatSpeed(this.result.downloadSpeed))
      const upload = style()
        .bold(true)
        .foreground(UPLOAD)
        .render('↑ ' + formatSpeed(this.result.uploadSpeed))
      return `${label}  ${download}  ${upload}`
    }

    const downloadElapsed = Math.max(Math.min(this.snapshot.elapsed, PHASE_DURATION) / 1000, 0.1)
    const uploadElapsed = Math.max(
      Math.min(Math.max(this.snapshot.elapsed - PHASE_DURATION, 0), PHASE_DURATION) / 1000,
      0.1
    )
    const download = this.snapshot.peers.reduce((total, peer) => total + peer.downloaded, 0)
    const upload = this.snapshot.peers.reduce((total, peer) => total + peer.uploaded, 0)
    const downloadView = style()
      .bold(true)
      .foreground(DOWNLOAD)
      .render(`↓ ${formatSpeed(download / downloadElapsed)}`)
    const uploadView = style()
      .bold(true)
      .foreground(UPLOAD)
      .render(`↑ ${formatSpeed(upload / uploadElapsed)}`)
    return `${label}  ${downloadView}  ${uploadView}`
  }
}

async function runTui(op, lobby) {
  const model = new ClientModel(op, lobby)
  const program = new Program(model, { altScreen: false })
  model._resize(program.output.columns || 80, program.output.rows || 24)
  const onupdate = (snapshot) => program.send({ type: 'state', snapshot })
  op.on('update', onupdate)
  try {
    const final = await program.run()
    if (final.error) throw final.error
    return final.result
  } finally {
    op.removeListener('update', onupdate)
  }
}

function printResults(result) {
  console.log('')
  console.log('  🍐 PEAR SPEED')
  for (const peer of result.peers) {
    console.log(
      `  ${formatAddress(peer).padEnd(22)}  ${formatLatency(peer.latency).padStart(8)}  ↓ ${formatSpeed(peer.downloadSpeed).padStart(12)}  ↑ ${formatSpeed(peer.uploadSpeed).padStart(12)}`
    )
  }
  console.log('')
  console.log(
    `  RESULT  ↓ ${formatSpeed(result.downloadSpeed)}  ↑ ${formatSpeed(result.uploadSpeed)}`
  )
  console.log(
    `  ${result.verified ? '✓ completed' : '⚠ peer byte mismatch'} · receipts ↓ ${(result.downloadRatio * 100).toFixed(1)}% ↑ ${(result.uploadRatio * 100).toFixed(1)}%`
  )
  console.log('')
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '-'
  const bits = bytesPerSecond * 8
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} Kbps`
  return `${bits.toFixed(0)} bps`
}

function formatLatency(ms) {
  return ms > 0 ? `${ms} ms` : '—'
}

function formatAddress(peer, styled = false) {
  let host = peer.ip.includes(':') ? `[${peer.ip}]` : peer.ip
  if (styled && peer.failed) host = style().foreground('red').render(host)
  if (!peer.port) return host
  const port = `:${peer.port}`
  return host + (styled ? style().faint(true).render(port) : port)
}
