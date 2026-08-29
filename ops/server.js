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
  CONNECTIONS,
  DURATION,
  TARGET_TIMEOUT,
  SESSION_TIMEOUT,
  BOOTSTRAP
} = require('./constants')

module.exports = class Server extends EventEmitter {
  constructor(maxConnections = CONNECTIONS, topic = TOPIC) {
    super()
    this.maxConnections = maxConnections
    this.topic = topic
    this.active = new Set()
    this.swarm = new Hyperswarm({ bootstrap: BOOTSTRAP, maxPeers: maxConnections })
    this.discovery = null
    this.closing = null
    this._resolveClose = null
    this._unregister = onexit(() => this.close())
  }

  async run() {
    const closed = new Promise((resolve) => {
      this._resolveClose = resolve
    })
    this.swarm.on('connection', (socket) => this._accept(socket))
    this.swarm.on('error', () => {})

    try {
      await this.swarm.dht.bind()
      const { port } = this.swarm.dht.localAddress()
      this.emit('listening', { port })
      this.discovery = this.swarm.join(this.topic, { client: false, server: true })
      if (await this.discovery.flushed()) this.emit('announced')
    } catch (err) {
      await this.close()
      throw err
    }
    if (this.closing) return this.closing
    await closed
  }

  _accept(socket) {
    if (this.active.size >= this.maxConnections) {
      socket.destroy()
      return
    }

    this.active.add(socket)
    socket.setTimeout(TARGET_TIMEOUT)
    socket.once('close', () => this.active.delete(socket))
    const rawStream = socket.rawStream
    const ip = normalizeIP(
      (rawStream && (rawStream.remoteHost || rawStream.remoteAddress)) || 'unknown'
    )
    const port = rawStream && rawStream.remotePort ? rawStream.remotePort : 0
    serve(socket, (sent, received) => this.emit('result', { ip, port, sent, received }))
  }

  close() {
    if (this.closing) return this.closing
    this.closing = this._close()
    return this.closing
  }

  async _close() {
    for (const socket of this.active) socket.destroy()
    if (this.discovery) await this.discovery.destroy().catch(() => {})
    try {
      await this.swarm.destroy()
    } catch {}
    this._unregister(true)
    this.emit('close')
    this.removeAllListeners()
    if (this._resolveClose) this._resolveClose()
  }
}

function serve(socket, onresult) {
  let ready = false
  let downloading = false
  let uploading = false
  let done = false
  let received = 0
  let sent = 0
  let sending = false
  let control = b4a.alloc(0)
  let deadline = setTimeout(() => socket.destroy(), TARGET_TIMEOUT)

  socket.once('close', () => clearTimeout(deadline))

  socket.on('data', (data) => {
    if (done) return socket.destroy()
    if (data.byteLength > DATA.byteLength) return socket.destroy()

    if (!ready) {
      data = readToken(data, START)
      if (!data) return

      ready = true
      socket.setTimeout(SESSION_TIMEOUT)
      clearTimeout(deadline)
      deadline = null
      socket.write(READY)
    }

    if (!downloading) {
      data = readToken(data, DOWNLOAD)
      if (!data) return

      downloading = true
      sending = true
      setDeadline(DURATION + TARGET_TIMEOUT)
      upload()
    }

    if (!uploading) {
      data = readToken(data, UPLOAD)
      if (!data) return

      sending = false
      uploading = true
    }

    let offset = 0
    while (offset < data.byteLength && data[offset] === 0) offset++
    received += offset
    if (offset === data.byteLength) return

    data = readToken(data.subarray(offset), STOP)
    if (!data) return
    if (data.byteLength) return socket.destroy()

    done = true
    sending = false
    clearTimeout(deadline)
    onresult(sent, received)
    socket.end(
      b4a.from(
        JSON.stringify({
          type: 'result',
          downloaded: sent,
          uploaded: received
        })
      )
    )
  })

  socket.on('error', () => {})

  function upload() {
    while (sending) {
      sent += DATA.byteLength
      if (!socket.write(DATA)) {
        socket.once('drain', upload)
        return
      }
    }
  }

  function setDeadline(ms) {
    clearTimeout(deadline)
    deadline = setTimeout(() => socket.destroy(), ms)
  }

  function readToken(data, token) {
    const length = Math.min(data.byteLength, token.byteLength - control.byteLength)
    control = b4a.concat([control, data.subarray(0, length)])
    if (control.byteLength < token.byteLength) return null
    if (!b4a.equals(control, token)) {
      socket.destroy()
      return null
    }
    control = b4a.alloc(0)
    return data.subarray(length)
  }
}

function normalizeIP(ip) {
  if (!ip) return 'unknown'
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}
