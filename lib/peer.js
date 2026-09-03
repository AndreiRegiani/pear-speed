'use strict'

const EventEmitter = require('bare-events')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const onexit = require('pear-gracedown')
const {
  TOPIC,
  HELLO,
  DOWNLOAD,
  UPLOAD,
  STOP,
  DATA,
  MAX_PEERS,
  PHASE_DURATION,
  REPORT_TIMEOUT,
  DISCOVERY_INTERVAL,
  TARGET_TIMEOUT,
  SESSION_TIMEOUT,
  MAX_REPORT,
  BOOTSTRAP
} = require('./constants')

module.exports = class Peer extends EventEmitter {
  constructor(topic = TOPIC, opts = {}) {
    super()
    this.topic = topic
    this.phaseDuration = opts.phaseDuration || PHASE_DURATION
    this.reportTimeout = opts.reportTimeout || REPORT_TIMEOUT
    this.targetTimeout = opts.targetTimeout || TARGET_TIMEOUT
    this.sessionTimeout = opts.sessionTimeout || SESSION_TIMEOUT
    this.discoveryInterval = opts.discoveryInterval || DISCOVERY_INTERVAL
    this.maxPeers = opts.maxPeers || MAX_PEERS
    this.peers = []
    this.swarm = new Hyperswarm({
      bootstrap: opts.bootstrap || BOOTSTRAP,
      dht: opts.dht,
      maxPeers: this.maxPeers
    })
    this.discovery = null
    this.phase = 'opening'
    this.startedAt = 0
    this.downloadDuration = 0
    this.uploadDuration = 0
    this.run = null
    this.opening = null
    this.closing = null
    this._testTimer = null
    this._reportTimer = null
    this._updateTimer = null
    this._discoveryTimer = null
    this._unregister = onexit(() => this.close())
  }

  open() {
    if (this.opening) return this.opening
    this.opening = this._open()
    return this.opening
  }

  async _open() {
    this.swarm.on('connection', (socket, info) => this._onconnection(socket, info))
    this.swarm.on('error', () => {})
    try {
      await this.swarm.dht.bind()
      this.discovery = this.swarm.join(this.topic, {
        client: true,
        server: true,
        limit: this.maxPeers
      })
      await this.discovery.flushed()
    } catch (err) {
      await this.close()
      throw err
    }
    if (this.closing) return
    this.phase = 'idle'
    this._discoveryTimer = setInterval(() => {
      this.discovery.refresh().catch(() => {})
    }, this.discoveryInterval)
    this._updateTimer = setInterval(() => this._update(), 100)
    this._update()
  }

  test() {
    if (this.phase !== 'idle') return Promise.reject(new Error('A speed test is already running'))
    const targets = this.peers.filter(
      (peer) => peer.ready && !peer.dropping && peer.mode === 'idle'
    )
    if (!targets.length) return Promise.reject(new Error('No peers are ready'))

    this.phase = 'download'
    this.startedAt = Date.now()
    this.downloadDuration = 0
    this.uploadDuration = 0
    this.run = { targets, resolve: null, reject: null }
    const result = new Promise((resolve, reject) => {
      this.run.resolve = resolve
      this.run.reject = reject
    })

    for (const peer of targets) {
      peer.mode = 'testing-download'
      peer.test = this.run
      peer.downloaded = 0
      peer.uploaded = 0
      peer.measuredDownload = 0
      peer.confirmedDownload = 0
      peer.confirmedUpload = 0
      peer.downloadSpeed = 0
      peer.uploadSpeed = 0
      peer.verified = false
      peer.lost = false
      peer.done = false
      peer.report = b4a.alloc(0)
      peer.socket.write(DOWNLOAD)
    }

    this._testTimer = setTimeout(() => this._startUpload(), this.phaseDuration)
    this._update()
    return result
  }

  _onconnection(socket, info) {
    if (!this._acceptConnection(socket)) return socket.destroy()
    const rawStream = socket.rawStream
    const peer = {
      socket,
      info,
      publicKey: info.publicKey,
      ip: normalizeIP(rawStream && (rawStream.remoteHost || rawStream.remoteAddress)),
      mode: 'handshake',
      ready: false,
      dropping: false,
      control: b4a.alloc(0),
      report: b4a.alloc(0),
      latency: 0,
      latencyStartedAt: Date.now(),
      downloaded: 0,
      uploaded: 0,
      measuredDownload: 0,
      confirmedDownload: 0,
      confirmedUpload: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      verified: false,
      lost: false,
      done: false,
      test: null,
      service: null,
      deadline: null
    }

    this.peers.push(peer)
    socket.setTimeout(this.targetTimeout)
    socket.on('data', (data) => this._ondata(peer, data))
    socket.on('error', () => this._ondisconnect(peer))
    socket.on('close', () => this._ondisconnect(peer))
    socket.write(HELLO)
    this._update()
  }

  _ondata(peer, data) {
    if (!data.byteLength) return
    if (data.byteLength > DATA.byteLength) return peer.socket.destroy()

    if (!peer.ready) {
      data = this._readToken(peer, data, HELLO)
      if (data === null) return
      peer.ready = true
      peer.mode = 'idle'
      peer.socket.setTimeout(0)
      peer.latency = Math.max(Date.now() - peer.latencyStartedAt, 1)
      this._update()
      if (!data.byteLength) return
    }

    if (peer.mode === 'idle') return this._startServing(peer, data)
    if (peer.mode === 'serving-download') return this._serveUpload(peer, data)
    if (peer.mode === 'serving-upload') return this._receiveUpload(peer, data)
    if (peer.mode === 'testing-download') return this._receiveDownload(peer, data)
    if (peer.mode === 'verifying') return this._receiveReport(peer, data)
    peer.socket.destroy()
  }

  _startServing(peer, data) {
    if (!peer.control.byteLength) this._setDeadline(peer, this.targetTimeout)
    data = this._readToken(peer, data, DOWNLOAD)
    if (data === null) return
    if (data.byteLength) return peer.socket.destroy()
    this._startDownloadService(peer)
  }

  _startDownloadService(peer) {
    peer.mode = 'serving-download'
    peer.service = { startedAt: Date.now(), sent: 0, received: 0 }
    this._setDeadline(peer, this.sessionTimeout)
    this._sendDownload(peer)
    this._update()
  }

  _sendDownload(peer) {
    while (peer.mode === 'serving-download') {
      peer.service.sent += DATA.byteLength
      if (!peer.socket.write(DATA)) {
        peer.socket.once('drain', () => this._sendDownload(peer))
        return
      }
    }
  }

  _serveUpload(peer, data) {
    data = this._readToken(peer, data, UPLOAD)
    if (data === null) return
    peer.mode = 'serving-upload'
    if (data.byteLength) this._receiveUpload(peer, data)
    this._update()
  }

  _receiveUpload(peer, data) {
    let offset = 0
    while (offset < data.byteLength && data[offset] === 0) offset++
    peer.service.received += offset
    if (offset === data.byteLength) return

    data = this._readToken(peer, data.subarray(offset), STOP)
    if (data === null) return
    if (data.byteLength) return peer.socket.destroy()

    const { sent, received } = peer.service
    clearTimeout(peer.deadline)
    peer.deadline = null
    peer.service = null
    peer.mode = 'idle'
    peer.socket.write(
      b4a.from(
        JSON.stringify({
          type: 'result',
          downloaded: sent,
          uploaded: received
        })
      )
    )
    this._update()
    this.emit('served', { timestamp: Date.now(), ip: peer.ip, sent, received })
  }

  _receiveDownload(peer, data) {
    if (peer.downloaded === 0 && data[0] !== 0) {
      data = this._readToken(peer, data, DOWNLOAD)
      if (data === null) return
      if (data.byteLength) return peer.socket.destroy()
      if (b4a.compare(this.swarm.keyPair.publicKey, peer.publicKey) < 0) return
      peer.done = true
      peer.lost = true
      this._startDownloadService(peer)
      return
    }

    let offset = 0
    while (offset < data.byteLength && data[offset] === 0) offset++
    peer.downloaded += offset
    if (offset !== data.byteLength) peer.socket.destroy()
  }

  _startUpload() {
    if (this.phase !== 'download') return
    this.downloadDuration = Date.now() - this.startedAt
    this.phase = 'upload'

    for (const peer of this.run.targets) {
      if (peer.done) continue
      peer.measuredDownload = peer.downloaded
      peer.mode = 'testing-upload'
      peer.socket.pause()
      peer.socket.write(UPLOAD)
      this._sendUpload(peer)
    }

    this._testTimer = setTimeout(() => this._stop(), this.phaseDuration)
    this._update()
  }

  _sendUpload(peer) {
    while (this.phase === 'upload' && peer.mode === 'testing-upload' && !peer.done) {
      peer.uploaded += DATA.byteLength
      if (!peer.socket.write(DATA)) {
        peer.socket.once('drain', () => this._sendUpload(peer))
        return
      }
    }
  }

  _stop() {
    if (this.phase !== 'upload') return
    this.uploadDuration = Date.now() - this.startedAt - this.downloadDuration
    this.phase = 'verifying'

    for (const peer of this.run.targets) {
      if (peer.done) continue
      peer.mode = 'verifying'
      peer.socket.write(STOP)
      peer.socket.resume()
    }

    if (this.run.targets.every((peer) => peer.done)) return this._finish()
    this._reportTimer = setTimeout(() => this._finish(), this.reportTimeout)
    this._update()
  }

  _receiveReport(peer, data) {
    if (!peer.report.byteLength) {
      let offset = 0
      while (offset < data.byteLength && data[offset] === 0) offset++
      peer.downloaded += offset
      if (offset === data.byteLength) return
      data = data.subarray(offset)
    }

    if (peer.report.byteLength + data.byteLength > MAX_REPORT) return peer.socket.destroy()
    peer.report = b4a.concat([peer.report, data])

    let report
    try {
      report = JSON.parse(b4a.toString(peer.report))
    } catch {
      return
    }

    if (
      report === null ||
      typeof report !== 'object' ||
      report.type !== 'result' ||
      !Number.isSafeInteger(report.downloaded) ||
      !Number.isSafeInteger(report.uploaded) ||
      report.downloaded < 0 ||
      report.uploaded < 0 ||
      peer.done
    ) {
      peer.socket.destroy()
      return
    }

    peer.confirmedDownload = report.downloaded
    peer.confirmedUpload = report.uploaded
    peer.verified =
      peer.downloaded === peer.confirmedDownload && peer.uploaded === peer.confirmedUpload
    peer.done = true
    peer.mode = 'idle'
    this._update()
    if (this.run.targets.every((target) => target.done)) this._finish()
  }

  _ondisconnect(peer) {
    const index = this.peers.indexOf(peer)
    if (index === -1) return
    this.peers.splice(index, 1)
    clearTimeout(peer.deadline)
    if (this.run && peer.test === this.run && !peer.done) {
      peer.done = true
      peer.lost = true
      if (this.phase === 'download') peer.measuredDownload = peer.downloaded
      if (this.phase === 'verifying' && this.run.targets.every((target) => target.done)) {
        this._finish()
      }
    }
    this._update()
  }

  _finish() {
    if (!this.run) return
    const run = this.run
    clearTimeout(this._reportTimer)
    for (const peer of run.targets) {
      if (!peer.done) {
        peer.done = true
        peer.lost = true
        peer.socket.destroy()
      }
      const upload = peer.verified ? peer.confirmedUpload : 0
      peer.downloadSpeed =
        (peer.measuredDownload * 1000) / (this.downloadDuration || this.phaseDuration)
      peer.uploadSpeed = (upload * 1000) / (this.uploadDuration || this.phaseDuration)
    }

    const receivedDownload = run.targets.reduce((total, peer) => total + peer.downloaded, 0)
    const confirmedDownload = run.targets.reduce((total, peer) => total + peer.confirmedDownload, 0)
    const attemptedUpload = run.targets.reduce((total, peer) => total + peer.uploaded, 0)
    const peers = run.targets.map((peer) => ({
      ip: peer.ip,
      latency: getLatency(peer),
      downloaded: peer.measuredDownload,
      uploaded: peer.verified ? peer.confirmedUpload : 0,
      downloadSpeed: peer.downloadSpeed,
      uploadSpeed: peer.uploadSpeed,
      verified: peer.verified
    }))
    const uploaded = peers.reduce((total, peer) => total + peer.uploaded, 0)
    const result = {
      peers,
      downloadSpeed: peers.reduce((total, peer) => total + peer.downloadSpeed, 0),
      uploadSpeed: peers.reduce((total, peer) => total + peer.uploadSpeed, 0),
      verified: peers.every((peer) => peer.verified),
      downloadRatio: confirmedDownload ? receivedDownload / confirmedDownload : 0,
      uploadRatio: attemptedUpload ? uploaded / attemptedUpload : 0
    }

    for (const peer of run.targets) peer.test = null
    this.run = null
    this.phase = 'idle'
    this.startedAt = 0
    this._update()
    run.resolve(result)
  }

  snapshot() {
    const elapsed = this.startedAt
      ? Math.min(Date.now() - this.startedAt, this.phaseDuration * 2)
      : 0
    const peers = this.run ? this.run.targets : this.peers
    return {
      phase: this.phase,
      elapsed,
      publicIP: this.swarm.dht.host ? normalizeIP(this.swarm.dht.host) : null,
      serving: this.peers
        .filter((peer) => peer.mode.startsWith('serving-'))
        .map((peer) => ({ timestamp: peer.service.startedAt, ip: peer.ip })),
      peers: peers
        .filter((peer) => peer.ready && !peer.dropping)
        .map((peer) => ({
          ip: peer.ip,
          latency: getLatency(peer),
          downloaded: this.phase === 'download' ? peer.downloaded : peer.measuredDownload,
          uploaded: peer.done ? (peer.verified ? peer.confirmedUpload : 0) : peer.uploaded,
          downloadSpeed: peer.downloadSpeed,
          uploadSpeed: peer.uploadSpeed,
          available: peer.mode === 'idle',
          failed: peer.lost
        }))
    }
  }

  _readToken(peer, data, token) {
    const length = Math.min(data.byteLength, token.byteLength - peer.control.byteLength)
    peer.control = b4a.concat([peer.control, data.subarray(0, length)])
    if (peer.control.byteLength < token.byteLength) return null
    if (!b4a.equals(peer.control, token)) {
      peer.socket.destroy()
      return null
    }
    peer.control = b4a.alloc(0)
    return data.subarray(length)
  }

  _setDeadline(peer, ms) {
    clearTimeout(peer.deadline)
    peer.deadline = setTimeout(() => peer.socket.destroy(), ms)
  }

  _update() {
    this._trimPeers()
    this.emit('update', this.snapshot())
  }

  _trimPeers() {
    if (this.run) return
    const peers = this.peers.filter((peer) => peer.ready && !peer.dropping)
    const overflow = peers.length - this.maxPeers
    if (overflow <= 0) return

    const idle = peers
      .filter((peer) => peer.mode === 'idle')
      .sort((a, b) => getLatency(b) - getLatency(a) || b.latencyStartedAt - a.latencyStartedAt)

    for (const peer of idle.slice(0, overflow)) {
      peer.dropping = true
      peer.info.reconnect(false)
      peer.socket.destroy()
    }
  }

  _atCapacity() {
    return this.peers.length >= this.maxPeers
  }

  _acceptConnection(socket) {
    if (!this._atCapacity()) return true
    if (this.run) return false
    const latency = socket.rawStream ? socket.rawStream.rtt : 0
    if (!Number.isFinite(latency) || latency <= 0) return false

    const worst = this.peers
      .filter(
        (peer) =>
          peer.ready && !peer.dropping && peer.mode === 'idle' && peer.control.byteLength === 0
      )
      .sort((a, b) => getLatency(b) - getLatency(a) || b.latencyStartedAt - a.latencyStartedAt)[0]

    if (!worst || latency >= getLatency(worst)) return false
    worst.dropping = true
    worst.info.reconnect(false)
    this._ondisconnect(worst)
    worst.socket.destroy()
    return true
  }

  close() {
    if (this.closing) return this.closing
    this.closing = this._close()
    return this.closing
  }

  async _close() {
    clearTimeout(this._testTimer)
    clearTimeout(this._reportTimer)
    clearInterval(this._updateTimer)
    clearInterval(this._discoveryTimer)
    if (this.run) {
      this.run.reject(new Error('Speed test stopped'))
      this.run = null
    }
    this._unregister(true)
    for (const peer of this.peers) peer.socket.destroy()
    if (this.discovery) await this.discovery.destroy().catch(() => {})
    try {
      await this.swarm.destroy()
    } catch {}
    this.phase = 'closed'
    this.removeAllListeners()
  }
}

function getLatency(peer) {
  const rtt = peer.socket.rawStream ? peer.socket.rawStream.rtt : 0
  if (rtt > 0) peer.latency = rtt
  return peer.latency
}

function normalizeIP(ip) {
  if (typeof ip !== 'string' || !ip) return 'unknown'
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  return normalized.replace(/[^\x20-\x7e]/g, '').slice(0, 64) || 'unknown'
}
