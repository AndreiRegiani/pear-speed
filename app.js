'use strict'

const FramedStream = require('framed-stream')
const PearRuntime = require('pear-runtime')
const ReadyResource = require('ready-resource')

module.exports = class App extends ReadyResource {
  constructor(opts) {
    super()
    this.opts = opts
    this.IPC = null
    this.pipe = null
  }

  _open() {
    this.IPC = PearRuntime.run(require.resolve('./workers/main.js'), [
      String(this.opts.updates),
      this.opts.version,
      this.opts.upgrade,
      this.opts.name,
      this.opts.dir,
      this.opts.app || ''
    ])
    this.pipe = new FramedStream(this.IPC)
    this.pipe.on('data', (data) => this._onmessage(data))
    this.pipe.on('error', (err) => this.emit('error', err))
    this.IPC.on('error', (err) => this.emit('error', err))
    this.IPC.on('exit', (code) => {
      if (code === 0 || this.closing !== null || this.closed) return
      this.emit('error', new Error(`Updates worker exited with code ${code}`))
    })
  }

  _close() {
    const pipe = this.pipe
    const IPC = this.IPC
    this.pipe = null
    this.IPC = null
    pipe?.destroy()
    IPC?.destroy()
  }

  async exit(code = 0) {
    Bare.exitCode = code
    await this.close()
  }

  _onmessage(data) {
    const message = data.toString()
    if (message === 'updating') {
      this.emit('updating')
      return
    }
    if (message === 'updated') {
      this.emit('updated')
      this._send('pear:applyUpdate')
      return
    }
    if (message === 'pear:updateApplied') {
      this.emit('update-applied')
      return
    }
    this.emit('message', message)
  }

  _send(message) {
    if (this.pipe === null) return
    this.pipe.write(message)
  }
}
