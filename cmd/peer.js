'use strict'

const tty = require('bare-tty')
const { Program, key, progress, quit, spinner, style, table } = require('bare-tui')
const ip3country = require('ip3country')
const Peer = require('../ops/peer')
const { DURATION, PHASE_DURATION } = require('../ops/constants')
const { DOWNLOAD, UPLOAD } = require('./colors')
const createTopic = require('./topic')
const pkg = require('../package.json')

const LATENCY = '#C792EA'
const BORDER = 'gray'
const DOWNLOAD_BAR = ['#007A5A', DOWNLOAD]
const UPLOAD_BAR = ['#315F9F', UPLOAD]
const MAX_SERVER_LOGS = 100
const ACTION_COLORS = [
  '#FFB347',
  '#FFBA50',
  '#FFC159',
  '#FFC862',
  '#FFD06B',
  '#FFD775',
  '#FFE082',
  '#FFD775',
  '#FFD06B',
  '#FFC862',
  '#FFC159',
  '#FFBA50'
]
ip3country.init()

module.exports = async function run(cmd) {
  if (cmd.flags.version) {
    console.log(`pear-speed v${pkg.version}`)
    return
  }
  if (!tty.isTTY(0) || !tty.isTTY(1)) throw new Error('pear-speed requires an interactive terminal')

  const topic = cmd.flags.lobby === undefined ? undefined : createTopic(cmd.flags.lobby)
  const op = new Peer(topic)
  await runTui(op, cmd.flags.lobby === undefined ? 'PUBLIC' : formatLobby(cmd.flags.lobby))
}

class PeerModel {
  constructor(op, lobby) {
    this.op = op
    this.lobby = lobby
    this.snapshot = { phase: 'opening', elapsed: 0, serving: [], peers: [] }
    this.result = null
    this.error = null
    this.exiting = false
    this.narrow = false
    this.activeTable = 'peer'
    this.maxTableHeight = 10
    this.serverLogs = []
    this.spinner = spinner.create({ frames: spinner.points, fps: 6 })
    this.servingSpinner = spinner.create({ frames: spinner.dots, fps: 8 })
    this.bar = progress.create({
      width: 50,
      full: '━',
      empty: '━',
      gradient: DOWNLOAD_BAR
    })
    this.peerTable = table.create({ height: 1 })
    this.serverLogTable = table.create({ height: 1 })
    this._resize(80, 24)
  }

  init() {
    return [
      this.spinner.init(),
      this.servingSpinner.init(),
      async () => {
        try {
          await this.op.open()
          return { type: 'open' }
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

    if (msg.type === 'served') {
      this.serverLogs.push({ timestamp: msg.entry.timestamp, ip: msg.entry.ip })
      if (this.serverLogs.length > MAX_SERVER_LOGS) this.serverLogs.shift()
      this._rows()
      return [this, null]
    }

    if (msg.type === 'spinner.tick') {
      const [spinner, cmd] = this.spinner.update(msg)
      this.spinner = spinner
      const [servingSpinner, servingCmd] = this.servingSpinner.update(msg)
      this.servingSpinner = servingSpinner
      if (this.snapshot.serving.length) this._rows()
      return [this, this.exiting ? null : cmd || servingCmd]
    }

    if (msg.type === 'open') {
      this.error = null
      return [this, null]
    }

    if (msg.type === 'done') {
      this.result = msg.result
      this.error = null
      this._rows()
      return [this, null]
    }

    if (msg.type === 'error') {
      this.error = msg.error
      return [this, null]
    }

    if (key.matches(msg, 'q', 'ctrl+c')) return this._quit()

    if (
      key.matches(msg, 'enter') &&
      this.snapshot.phase === 'idle' &&
      this.snapshot.peers.some((peer) => peer.available)
    ) {
      this.result = null
      this.error = null
      return [
        this,
        async () => {
          try {
            return { type: 'done', result: await this.op.test() }
          } catch (error) {
            return { type: 'error', error }
          }
        }
      ]
    }

    if (msg.type === 'key') {
      if (key.matches(msg, 'tab')) {
        this.activeTable = this.activeTable === 'peer' ? 'server' : 'peer'
        return [this, null]
      }
      const active = this.activeTable === 'peer' ? this.peerTable : this.serverLogTable
      const maxOffset = Math.max(0, active.rows.length - active.height)
      if (key.matches(msg, 'up', 'k')) {
        active.offset = Math.max(0, active.offset - 1)
      }
      if (key.matches(msg, 'down', 'j')) {
        active.offset = Math.min(maxOffset, active.offset + 1)
      }
      if (key.matches(msg, 'pageup')) {
        active.offset = Math.max(0, active.offset - active.height)
      }
      if (key.matches(msg, 'pagedown')) {
        active.offset = Math.min(maxOffset, active.offset + active.height)
      }
      if (key.matches(msg, 'home')) active.offset = 0
      if (key.matches(msg, 'end')) active.offset = maxOffset
    }

    return [this, null]
  }

  _quit() {
    if (this.exiting) return [this, null]
    this.exiting = true
    return [
      this,
      async () => {
        await this.op.close()
        return quit()
      }
    ]
  }

  _rows() {
    const [downloadElapsed, uploadElapsed] = phaseSeconds(this.snapshot.elapsed)
    const idle = this.snapshot.phase === 'idle'
    const peerRows = this.snapshot.peers
      .slice()
      .sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity))
      .map((peer) => {
        const downloadSpeed = idle ? peer.downloadSpeed : peer.downloaded / downloadElapsed
        const uploadSpeed = idle ? peer.uploadSpeed : peer.uploaded / uploadElapsed
        const row = [
          ` ${formatAddress(peer)}`,
          style().foreground(LATENCY).render(formatLatency(peer.latency)),
          style().foreground(DOWNLOAD).render(formatSpeed(downloadSpeed)),
          style().foreground(UPLOAD).render(formatSpeed(uploadSpeed))
        ]
        if (this.narrow) return [row[0], row[2], row[3]]
        return row
      })
    if (!peerRows.length) peerRows.push(this.narrow ? [' -', '', ''] : [' -', '', '', ''])
    const serverLogRows = this.serverLogs
      .map((entry) => [
        ` ${style().foreground('gray').render(formatTime(entry.timestamp))} ${formatAddress({ ip: entry.ip })}`
      ])
      .concat(
        this.snapshot.serving.map((ip) => [
          style()
            .foreground(DOWNLOAD)
            .render(` ${this.servingSpinner.view()} ${formatAddress({ ip })}`)
        ])
      )
    if (!serverLogRows.length) serverLogRows.push([' -'])
    const peerHeight = Math.min(Math.max(peerRows.length, 1), this.maxTableHeight)
    const serverLogHeight = Math.min(Math.max(serverLogRows.length, 1), this.maxTableHeight)
    this.peerTable.height = peerHeight
    this.peerTable.setRows(peerRows)
    this.peerTable.offset = Math.min(
      this.peerTable.offset,
      Math.max(0, peerRows.length - peerHeight)
    )
    this.peerTable.cursor = -1
    this.serverLogTable.height = serverLogHeight
    this.serverLogTable.setRows(serverLogRows)
    this.serverLogTable.offset = Math.min(
      this.serverLogTable.offset,
      Math.max(0, serverLogRows.length - serverLogHeight)
    )
    this.serverLogTable.cursor = -1
  }

  _resize(screenWidth = 80, screenHeight = 24) {
    const tablesWidth = Math.max(53, screenWidth - 6)
    const serverLogWidth = Math.max(21, Math.floor(tablesWidth * 0.4))
    const peerWidth = tablesWidth - serverLogWidth
    const peerColumnWidth = Math.max(1, Math.min(43, Math.floor(peerWidth * 0.3)))
    const remainingWidth = peerWidth - peerColumnWidth - 3
    const latencyWidth = Math.max(8, Math.floor(remainingWidth * 0.25))
    const downloadWidth = Math.floor((remainingWidth - latencyWidth) / 2)
    const uploadWidth = remainingWidth - latencyWidth - downloadWidth
    this.narrow = peerWidth < 48
    this.screenHeight = screenHeight
    this.maxTableHeight = Math.max(1, screenHeight - 15)
    this.bar.setWidth(Math.min(50, tablesWidth))
    this.peerTable.setColumns(
      this.narrow
        ? [
            { title: ' Peers', width: peerWidth - 22 },
            { title: '↓ Download', width: 10 },
            { title: '↑ Upload', width: 10 }
          ]
        : [
            { title: ' Peers', width: peerColumnWidth },
            { title: 'Latency', width: latencyWidth },
            { title: '↓ Download', width: downloadWidth },
            { title: '↑ Upload', width: uploadWidth }
          ]
    )
    this.serverLogTable.setColumns([{ title: ' SERVED', width: serverLogWidth }])
    this._rows()
  }

  view() {
    if (this.exiting) {
      return ['', '  Quitting...', ...Array(Math.max(0, this.screenHeight - 2)).fill('')].join('\n')
    }

    const title = style().bold(true).foreground(DOWNLOAD).render('🍐 PEAR SPEED')
    const lobbyName = this.lobby === 'PUBLIC' ? this.lobby : `🔒 ${this.lobby}`
    const lobby = `${style().foreground('white').render('Lobby:')} ${style().foreground('gray').render(lobbyName)}`
    const phase = this._phase()
    this.bar.gradient = this.snapshot.phase === 'upload' ? UPLOAD_BAR : DOWNLOAD_BAR
    const progressView = this.bar.view(this.result ? 1 : this.snapshot.elapsed / DURATION)
    const peerTable = style()
      .border(style.borders.rounded)
      .borderForeground(BORDER)
      .render(this.peerTable.view())
    const serverLogTable = style().margin(1, 0, 1).render(this.serverLogTable.view())
    const body = style()
      .margin(0, 1, 0, 1)
      .render(style.joinHorizontal(style.position.top, peerTable, '  ', serverLogTable))

    const content = [
      '',
      `  ${title} · ${lobby}`,
      '',
      body,
      '',
      `    ${phase}`,
      `    ${progressView}`,
      `    ${this._resultView()}`,
      '',
      '',
      `    ${this._actions()}`
    ]
    const contentHeight = content.join('\n').split('\n').length
    const padding = Math.max(0, this.screenHeight - contentHeight - 1)

    return [...content, ...Array.from({ length: padding }, () => ''), `  ${this._footer()}`].join(
      '\n'
    )
  }

  _phase() {
    if (this.error) return style().foreground('red').render(this.error.message)
    if (this.snapshot.phase === 'opening') {
      const activity = style().foreground(DOWNLOAD).render(this.spinner.view())
      return `${activity} Joining lobby`
    }
    if (this.snapshot.phase === 'verifying') {
      const activity = style().foreground('yellow').render(this.spinner.view())
      return `${activity} Verifying results`
    }
    if (this.snapshot.phase === 'idle') {
      if (this.result) {
        return `Completed · ${formatPeers(this.result.peers.length)}`
      }
      const available = this.snapshot.peers.filter((peer) => peer.available).length
      if (!available) {
        const activity = style().foreground(DOWNLOAD).render(this.spinner.view())
        return `${activity} Finding peers`
      }
      return formatPeers(available)
    }
    const upload = this.snapshot.phase === 'upload'
    const remaining = Math.max(0, Math.ceil((DURATION - this.snapshot.elapsed) / 1000))
    const direction = style()
      .foreground(upload ? UPLOAD : DOWNLOAD)
      .render(upload ? '↑ Upload' : '↓ Download')
    return `${direction} · ${formatPeers(this.snapshot.peers.length)} · ${remaining}s remaining`
  }

  _resultView() {
    const label = style().faint(true).render('TOTAL')
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

    const [downloadElapsed, uploadElapsed] = phaseSeconds(this.snapshot.elapsed)
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

  _actions() {
    const actions = []
    if (this.snapshot.phase === 'idle') {
      const available = this.snapshot.peers.some((peer) => peer.available)
      if (this.result) actions.push(this._startAction('Press [ENTER] to start'))
      else if (available) actions.push(this._startAction('[ENTER] Start test'))
    }
    if (
      this.peerTable.rows.length > this.peerTable.height ||
      this.serverLogTable.rows.length > this.serverLogTable.height
    ) {
      actions.push(style().faint(true).render('[↑/↓] Scroll · [TAB] Switch table'))
    }
    return actions.join(' · ')
  }

  _footer() {
    return style().faint(true).render('[q] Quit')
  }

  _startAction(label) {
    return style()
      .foreground(ACTION_COLORS[this.spinner.frame % ACTION_COLORS.length])
      .render(label)
  }
}

async function runTui(op, lobby) {
  const model = new PeerModel(op, lobby)
  const program = new Program(model, { altScreen: true })
  model._resize(program.output.columns || 80, program.output.rows || 24)
  const onupdate = (snapshot) => program.send({ type: 'state', snapshot })
  const onserved = (entry) => program.send({ type: 'served', entry })
  op.on('update', onupdate)
  op.on('served', onserved)
  try {
    await program.run()
  } finally {
    op.removeListener('update', onupdate)
    op.removeListener('served', onserved)
    await op.close()
  }
  program.output.write(finalView(model))
}

function finalView(model) {
  return `\x1b[H\x1b[2J\n  ${model._phase()}\n  ${model.bar.view(1)}\n  ${model._resultView()}\n\n`
}

function phaseSeconds(elapsed) {
  const download = Math.max(Math.min(elapsed, PHASE_DURATION) / 1000, 0.1)
  const upload = Math.max(
    Math.min(Math.max(elapsed - PHASE_DURATION, 0), PHASE_DURATION) / 1000,
    0.1
  )
  return [download, upload]
}

function formatTime(timestamp) {
  const date = new Date(timestamp)
  const values = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  ].map((value) => String(value).padStart(2, '0'))
  return `${values.slice(0, 3).join('-')} ${values.slice(3).join(':')}`
}

function formatLobby(value) {
  const safe = Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0)
      return code >= 32 && code !== 127 && (code < 128 || code > 159)
    })
    .slice(0, 48)
    .join('')
  return safe || 'PRIVATE'
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

function formatAddress(peer, gap = ' ') {
  const country = ip3country.lookupStr(peer.ip)
  const octets = peer.ip.split('.').map(Number)
  const lan =
    (octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
      (octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168))) ||
    peer.ip === '::' ||
    peer.ip === '::1' ||
    /^f[cd][0-9a-f]{2}:/i.test(peer.ip) ||
    /^fe[89ab][0-9a-f]:/i.test(peer.ip)
  const marker = country
    ? `${String.fromCodePoint(country.charCodeAt(0) + 127397, country.charCodeAt(1) + 127397)}${gap}`
    : lan
      ? `🏠${gap}`
      : ''
  let host = peer.ip
  if (peer.failed) host = style().foreground('red').render(host)
  return marker + host
}

function formatPeers(peers) {
  return `${peers} ${peers === 1 ? 'peer' : 'peers'}`
}

module.exports.PeerModel = PeerModel
module.exports.finalView = finalView
