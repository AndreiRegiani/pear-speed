'use strict'

const b4a = require('b4a')
const test = require('brittle')
const Client = require('../ops/client')
const { DURATION, PHASE_DURATION } = require('../ops/constants')

test('force start selects ready peers', (t) => {
  const ready = [createPeer(true), createPeer(true)]
  const waiting = createPeer(false)
  const speedTest = createTest(5, [...ready, waiting])

  speedTest.forceStart()

  t.is(speedTest.peerLimit, 2)
  t.ok(speedTest.peers.every((peer) => ready.includes(peer)))
  t.ok(waiting.socket.destroyed)
  t.ok(speedTest.started)
})

test('force start keeps the requested peer limit', (t) => {
  const peers = [createPeer(true), createPeer(true), createPeer(true)]
  const speedTest = createTest(2, peers)

  speedTest.forceStart()

  t.is(speedTest.peerLimit, 2)
  t.is(speedTest.peers.length, 2)
  t.is(peers.filter((peer) => peer.socket.destroyed).length, 1)
  t.ok(speedTest.started)
})

test('selects peers with the lowest latency', (t) => {
  const peers = [createPeer(true), createPeer(true), createPeer(true)]
  peers[0].latency = 20
  peers[1].latency = 5
  peers[2].latency = 10
  const speedTest = createTest(2, peers)

  speedTest._select()

  t.alike(
    speedTest.peers.map((peer) => peer.latency),
    [5, 10]
  )
  t.ok(peers[0].socket.destroyed)
})

test('matching receipt is verified', (t) => {
  const peer = createPeer(true)
  peer.downloaded = 1024
  peer.uploaded = 2048
  peer.done = false
  peer.report = b4a.alloc(0)
  const speedTest = Object.create(Client.prototype)
  speedTest.phase = 'verifying'
  speedTest.peers = [peer]
  speedTest.finished = false
  speedTest._finish = () => {
    speedTest.finished = true
  }

  speedTest._ondata(
    peer,
    b4a.from(
      JSON.stringify({
        type: 'result',
        downloaded: 1024,
        uploaded: 2048
      })
    )
  )

  t.ok(peer.verified)
  t.ok(peer.done)
  t.ok(speedTest.finished)
})

test('malformed receipts disconnect the peer', (t) => {
  const invalid = createReceiptTest('verifying')
  invalid.speedTest._ondata(invalid.peer, b4a.from('null'))
  t.ok(invalid.peer.socket.destroyed)

  const oversized = createReceiptTest('verifying')
  oversized.speedTest._ondata(oversized.peer, b4a.alloc(1025, 1))
  t.ok(oversized.peer.socket.destroyed)

  const early = createReceiptTest('upload')
  early.speedTest._ondata(early.peer, b4a.from('{"type":"result"}'))
  t.ok(early.peer.socket.destroyed)
})

test('unexpected server handshake disconnects the peer', (t) => {
  const peer = createPeer(false)
  peer.report = b4a.alloc(0)
  const speedTest = Object.create(Client.prototype)
  speedTest.phase = 'finding'
  speedTest.peers = [peer]

  speedTest._ondata(peer, b4a.alloc(32, 1))

  t.ok(peer.socket.destroyed)
})

test('post-result server data disconnects the peer', (t) => {
  const { speedTest, peer } = createReceiptTest('verifying')
  peer.done = true

  speedTest._ondata(peer, b4a.alloc(1))

  t.ok(peer.socket.destroyed)
})

test('oversized transfer data disconnects the peer', (t) => {
  const { speedTest, peer } = createReceiptTest('download')

  speedTest._ondata(peer, b4a.alloc(64 * 1024 + 1))

  t.ok(peer.socket.destroyed)
})

test('stop finishes when every peer is gone', (t) => {
  const speedTest = Object.create(Client.prototype)
  speedTest.startedAt = Date.now() - DURATION
  speedTest.downloadDuration = PHASE_DURATION
  speedTest.stopping = false
  speedTest.peers = [{ done: true }]
  speedTest.finished = false
  speedTest._finish = () => {
    speedTest.finished = true
  }

  speedTest._stop()

  t.ok(speedTest.finished)
})

test('last measured latency is retained', (t) => {
  const peer = createPeer(true)
  peer.latency = 7
  peer.downloaded = 0
  peer.uploaded = 0
  peer.done = false
  peer.ip = '127.0.0.1'
  peer.port = 1234
  peer.socket.rawStream = { rtt: 0 }
  const speedTest = Object.create(Client.prototype)
  speedTest.startedAt = 0
  speedTest.phase = 'download'
  speedTest.peerLimit = 1
  speedTest.peers = [peer]

  t.is(speedTest.snapshot().peers[0].port, 1234)
  t.is(speedTest.snapshot().peers[0].latency, 7)
  peer.socket.rawStream.rtt = 3
  t.is(speedTest.snapshot().peers[0].latency, 3)
  peer.socket.rawStream.rtt = 0
  t.is(speedTest.snapshot().peers[0].latency, 3)
})

function createTest(peerLimit, peers) {
  const speedTest = Object.create(Client.prototype)
  speedTest.peerLimit = peerLimit
  speedTest.phase = 'finding'
  speedTest.peers = peers
  speedTest._selectionTimer = null
  speedTest.started = false
  speedTest._startDownload = () => {
    speedTest.started = true
  }
  return speedTest
}

function createReceiptTest(phase) {
  const peer = createPeer(true)
  peer.downloaded = 0
  peer.uploaded = 0
  peer.done = false
  peer.report = b4a.alloc(0)
  const speedTest = Object.create(Client.prototype)
  speedTest.phase = phase
  speedTest.peers = [peer]
  return { speedTest, peer }
}

function createPeer(ready) {
  return {
    ready,
    socket: {
      destroyed: false,
      destroy() {
        this.destroyed = true
      }
    }
  }
}
