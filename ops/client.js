'use strict'

const EventEmitter = require('bare-events')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const onexit = require('pear-gracedown')
const {
  TOPIC,
  START,
  READY,
  DOWNLOAD,
  UPLOAD,
  STOP,
  DATA,
  PEERS,
  DURATION,
  PHASE_DURATION,
  REPORT_TIMEOUT,
  DISCOVERY_INTERVAL,
  SELECTION_DELAY,
  TARGET_TIMEOUT,
  MAX_REPORT,
  BOOTSTRAP
} = require('./constants')

module.exports = class Client extends EventEmitter {
  constructor(peerLimit = PEERS, topic = TOPIC) {
    super()
    this.peerLimit = peerLimit
    this.candidateLimit = peerLimit * 2
    this.topic = topic
    this.swarm = new Hyperswarm({ bootstrap: BOOTSTRAP, maxPeers: this.candidateLimit })
    this.discovery = null
    this.peers = []
    this.startedAt = 0
    this.downloadDuration = 0
    this.uploadDuration = 0
    this.phase = 'finding'
    this.stopping = false
    this.closed = false
    this._testTimer = null
    this._updateTimer = null
    this._discoveryTimer = null
    this._selectionTimer = null
    this._reportTimer = null
    this._resolve = null
    this._reject = null
    this._unregister = onexit(() => this.destroy())
  }

  run() {
    const result = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })

    this.swarm.on('connection', (socket, peerInfo) => {
      this._onconnection(socket)
    })
    this.swarm.on('error', (err) => this._fail(err))
    try {
      this.discovery = this.swarm.join(this.topic, {
        client: true,
        server: false,
        limit: this.candidateLimit
      })
      this._discoveryTimer = setInterval(() => {
        this.discovery.refresh().catch((err) => this._fail(err))
      }, DISCOVERY_INTERVAL)
    } catch (err) {
      this._fail(err)
      return result
    }
    this._updateTimer = setInterval(() => this._update(), 100)

    this._update()
    return result
  }

  _onconnection(socket) {
    if (this.phase !== 'finding' || this.peers.length >= this.candidateLimit) {
      socket.destroy()
      return
    }

    const rawStream = socket.rawStream
    const ip = normalizeIP(rawStream && rawStream.remoteHost)
    const port = rawStream && rawStream.remotePort

    socket.setTimeout(TARGET_TIMEOUT)

    const peer = {
      socket,
      ip,
      port: port || 0,
      downloaded: 0,
      uploaded: 0,
      measuredDownload: 0,
      confirmedDownload: 0,
      confirmedUpload: 0,
      latency: 0,
      latencyStartedAt: Date.now(),
      ready: false,
      verified: false,
      lost: false,
      done: false,
      report: b4a.alloc(0)
    }

    this.peers.push(peer)
    socket.on('data', (data) => this._ondata(peer, data))
    socket.on('error', () => this._ondisconnect(peer))
    socket.on('close', () => this._ondisconnect(peer))
    socket.write(START)
    this._update()
  }

  _select() {
    clearTimeout(this._selectionTimer)
    this._selectionTimer = null
    const candidates = this.peers.filter((peer) => peer.ready)
    if (this.phase !== 'finding' || candidates.length < this.peerLimit) return

    candidates.sort((a, b) => (getLatency(a) || Infinity) - (getLatency(b) || Infinity))

    const selected = candidates.slice(0, this.peerLimit)
    const rejected = this.peers.filter((peer) => !selected.includes(peer))
    this.peers = selected
    for (const peer of rejected) {
      peer.socket.destroy()
    }
    this._startDownload()
  }

  forceStart() {
    const candidates = this.peers.filter((peer) => peer.ready)
    if (this.phase !== 'finding' || !candidates.length) return
    this.peerLimit = Math.min(this.peerLimit, candidates.length)
    this._select()
  }

  _startDownload() {
    if (this.startedAt) return
    clearInterval(this._discoveryTimer)
    if (this.discovery) {
      this.discovery.destroy().catch(() => {})
      this.discovery = null
    }
    this.startedAt = Date.now()
    this.phase = 'download'

    for (const peer of this.peers) peer.socket.write(DOWNLOAD)

    this._testTimer = setTimeout(() => this._startUpload(), PHASE_DURATION)
    this._update()
  }

  _startUpload() {
    this.downloadDuration = Date.now() - this.startedAt
    this.phase = 'upload'

    for (const peer of this.peers) {
      if (peer.done) continue
      peer.measuredDownload = peer.downloaded
      peer.socket.pause()
      peer.socket.write(UPLOAD)
      this._upload(peer)
    }

    this._testTimer = setTimeout(() => this._stop(), PHASE_DURATION)
    this._update()
  }

  _upload(peer) {
    while (this.phase === 'upload' && !peer.done) {
      peer.uploaded += DATA.byteLength
      if (!peer.socket.write(DATA)) {
        peer.socket.once('drain', () => this._upload(peer))
        return
      }
    }
  }

  _ondata(peer, data) {
    if (peer.done) {
      peer.socket.destroy()
      return
    }

    if (data.byteLength > DATA.byteLength) {
      peer.socket.destroy()
      return
    }

    if (!peer.ready) {
      if (peer.report.byteLength + data.byteLength > MAX_REPORT) {
        peer.socket.destroy()
        return
      }
      peer.report = b4a.concat([peer.report, data])
      if (peer.report.byteLength < READY.byteLength) return
      if (!b4a.equals(peer.report.subarray(0, READY.byteLength), READY)) {
        peer.socket.destroy()
        return
      }

      peer.ready = true
      peer.socket.setTimeout(0)
      peer.latency = Math.max(Date.now() - peer.latencyStartedAt, 1)
      data = peer.report.subarray(READY.byteLength)
      peer.report = b4a.alloc(0)
      const candidates = this.peers.filter((peer) => peer.ready)
      if (candidates.length === this.candidateLimit) {
        this._select()
      } else if (candidates.length >= this.peerLimit && !this._selectionTimer) {
        this._selectionTimer = setTimeout(() => this._select(), SELECTION_DELAY)
      }
      this._update()
      if (!data.byteLength) return
    }

    if (this.phase === 'finding') {
      peer.socket.destroy()
      return
    }

    let offset = 0

    if (!peer.report.byteLength) {
      while (offset < data.byteLength && data[offset] === 0) offset++
      peer.downloaded += offset
      if (offset === data.byteLength) return
    }

    if (this.phase !== 'verifying') {
      peer.socket.destroy()
      return
    }

    data = data.subarray(offset)
    if (peer.report.byteLength + data.byteLength > MAX_REPORT) {
      peer.socket.destroy()
      return
    }
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
    this._update()

    if (this.peers.every((peer) => peer.done)) this._finish()
  }

  _stop() {
    if (this.stopping) return
    this.stopping = true
    this.uploadDuration = Date.now() - this.startedAt - this.downloadDuration
    this.phase = 'verifying'

    for (const peer of this.peers) {
      if (peer.done) continue
      peer.socket.write(STOP)
      peer.socket.resume()
    }

    if (this.peers.every((peer) => peer.done)) {
      this._finish()
      return
    }

    this._reportTimer = setTimeout(() => this._finish(), REPORT_TIMEOUT)
    this._update()
  }

  _ondisconnect(peer) {
    if (peer.done) return
    peer.done = true

    if (this.phase === 'finding') {
      const index = this.peers.indexOf(peer)
      if (index !== -1) this.peers.splice(index, 1)
      this._update()
      return
    }

    if (this.phase === 'download') peer.measuredDownload = peer.downloaded
    peer.lost = true
    if (this.stopping && this.peers.every((peer) => peer.done)) this._finish()
  }

  _update() {
    this.emit('update', this.snapshot())
  }

  snapshot() {
    const elapsed = this.startedAt ? Math.min(Date.now() - this.startedAt, DURATION) : 0
    const peers = this.phase === 'finding' ? this.peers.filter((peer) => peer.ready) : this.peers
    return {
      phase: this.phase,
      elapsed,
      peerLimit: this.peerLimit,
      peers: peers.slice(0, this.peerLimit).map((peer) =>
        peer.socket
          ? {
              ip: peer.ip,
              port: peer.port,
              latency: getLatency(peer),
              downloaded: this.phase === 'download' ? peer.downloaded : peer.measuredDownload,
              uploaded: peer.done ? (peer.verified ? peer.confirmedUpload : 0) : peer.uploaded,
              ready: peer.ready,
              failed: peer.lost
            }
          : {
              ip: peer.ip,
              port: peer.port,
              latency: 0,
              downloaded: 0,
              uploaded: 0,
              ready: false,
              failed: false
            }
      )
    }
  }

  async _finish() {
    if (this.closed) return
    clearTimeout(this._reportTimer)

    const receivedDownload = this.peers.reduce((total, peer) => total + peer.downloaded, 0)
    const confirmedDownload = this.peers.reduce((total, peer) => total + peer.confirmedDownload, 0)
    const attemptedUpload = this.peers.reduce((total, peer) => total + peer.uploaded, 0)
    const peers = this.peers.map((peer) => {
      const upload = peer.verified ? peer.confirmedUpload : 0
      return {
        ip: peer.ip,
        port: peer.port,
        latency: getLatency(peer),
        downloaded: peer.measuredDownload,
        uploaded: upload,
        downloadSpeed: (peer.measuredDownload * 1000) / (this.downloadDuration || PHASE_DURATION),
        uploadSpeed: (upload * 1000) / (this.uploadDuration || PHASE_DURATION),
        verified: peer.verified
      }
    })
    const uploaded = peers.reduce((total, peer) => total + peer.uploaded, 0)

    const result = {
      peers,
      downloadSpeed: peers.reduce((total, peer) => total + peer.downloadSpeed, 0),
      uploadSpeed: peers.reduce((total, peer) => total + peer.uploadSpeed, 0),
      verified: peers.length === this.peerLimit && peers.every((peer) => peer.verified),
      downloadRatio: confirmedDownload ? receivedDownload / confirmedDownload : 0,
      uploadRatio: attemptedUpload ? uploaded / attemptedUpload : 0
    }

    await this.destroy()
    this._resolve(result)
  }

  _fail(err) {
    if (this.closed) return
    this.destroy().then(() => this._reject(err))
  }

  async destroy() {
    if (this.closed) return
    this.closed = true
    this.stopping = true
    clearTimeout(this._testTimer)
    clearTimeout(this._selectionTimer)
    clearInterval(this._updateTimer)
    clearTimeout(this._reportTimer)
    clearInterval(this._discoveryTimer)
    this._unregister(true)
    for (const peer of this.peers) peer.socket.destroy()
    if (this.discovery) await this.discovery.destroy().catch(() => {})
    try {
      await this.swarm.destroy()
    } catch {}
    this.removeAllListeners()
  }
}

function getLatency(peer) {
  const rtt = peer.socket.rawStream ? peer.socket.rawStream.rtt : 0
  if (rtt > 0) peer.latency = rtt
  return peer.latency
}

function normalizeIP(ip) {
  if (!ip) return 'unknown'
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}
