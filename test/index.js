'use strict'

const b4a = require('b4a')
const { randomBytes } = require('bare-crypto')
const { KeyMsg, style } = require('bare-tui')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Peer = require('../lib/peer')
const createTopic = require('../cmd/topic')
const { PeerModel, finalView } = require('../cmd/peer')
const { TOPIC, HELLO, DOWNLOAD, DATA, MAX_PEERS, DISCOVERY_INTERVAL } = require('../lib/constants')

test('lobby names deterministically derive isolated swarm topics', (t) => {
  const first = createTopic('any secret')
  const same = createTopic('any secret')
  const different = createTopic('another lobby')
  t.is(first.byteLength, 32)
  t.ok(b4a.equals(first, same))
  t.absent(b4a.equals(first, different))
  t.is(TOPIC.byteLength, 32)
  t.absent(b4a.equals(TOPIC, first))
})

test('a test uses every ready idle peer', (t) => {
  const ready = [createPeer(), createPeer(), createPeer()]
  const serving = createPeer('serving-download')
  const speedTest = Object.create(Peer.prototype)
  speedTest.phase = 'idle'
  speedTest.peers = [...ready, serving]
  speedTest.phaseDuration = 10_000
  speedTest._update = () => {}

  speedTest.test()

  clearTimeout(speedTest._testTimer)
  t.is(speedTest.run.targets.length, 3)
  t.ok(ready.every((peer) => b4a.equals(peer.socket.writes[0], DOWNLOAD)))
  t.is(serving.socket.writes.length, 0)
})

test('matching receipt is verified and returns the connection to idle', (t) => {
  const peer = createPeer('verifying')
  peer.downloaded = 1024
  peer.uploaded = 2048
  peer.done = false
  peer.report = b4a.alloc(0)
  const speedTest = Object.create(Peer.prototype)
  speedTest.run = { targets: [peer] }
  speedTest.finished = false
  speedTest._update = () => {}
  speedTest._finish = () => {
    speedTest.finished = true
  }

  speedTest._receiveReport(
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
  t.is(peer.mode, 'idle')
  t.ok(speedTest.finished)
})

test('malformed receipts disconnect the peer', (t) => {
  const invalid = createReceiptTest()
  invalid.speedTest._receiveReport(invalid.peer, b4a.from('null'))
  t.ok(invalid.peer.socket.destroyed)

  const oversized = createReceiptTest()
  oversized.speedTest._receiveReport(oversized.peer, b4a.alloc(1025, 1))
  t.ok(oversized.peer.socket.destroyed)
})

test('invalid handshakes and oversized frames disconnect peers', (t) => {
  const speedTest = Object.create(Peer.prototype)
  speedTest._update = () => {}
  const invalid = createPeer('handshake')
  invalid.ready = false
  invalid.control = b4a.alloc(0)
  speedTest._ondata(invalid, b4a.alloc(HELLO.byteLength, 1))
  t.ok(invalid.socket.destroyed)

  const oversized = createPeer()
  speedTest._ondata(oversized, b4a.alloc(DATA.byteLength + 1))
  t.ok(oversized.socket.destroyed)
})

test('the connection limit keeps the lowest-latency idle peers', (t) => {
  t.is(MAX_PEERS, 32)
  const peers = Array.from({ length: MAX_PEERS + 1 }, (_, index) => {
    const peer = createPeer()
    peer.latency = index + 1
    peer.latencyStartedAt = index
    return peer
  })
  const speedTest = Object.create(Peer.prototype)
  speedTest.maxPeers = MAX_PEERS
  speedTest.peers = peers
  speedTest.run = {}

  speedTest._trimPeers()

  t.absent(peers.some((peer) => peer.dropping))

  speedTest.run = null
  speedTest._trimPeers()

  t.is(peers.filter((peer) => !peer.dropping).length, MAX_PEERS)
  t.ok(peers[MAX_PEERS].socket.destroyed)
  t.absent(peers[MAX_PEERS].reconnecting)
  t.absent(peers[MAX_PEERS - 1].socket.destroyed)
})

test('connections beyond the limit are rejected before allocation', (t) => {
  const speedTest = Object.create(Peer.prototype)
  speedTest.maxPeers = MAX_PEERS
  speedTest.peers = Array.from({ length: MAX_PEERS }, () => createPeer())
  const socket = createPeer().socket

  speedTest._onconnection(socket, {})

  t.ok(socket.destroyed)
  t.is(speedTest.peers.length, MAX_PEERS)
})

test('discovery retries promptly for late peers', (t) => {
  t.is(DISCOVERY_INTERVAL, 2_000)
})

test('snapshots include the public IP observed by the DHT', (t) => {
  const speedTest = Object.create(Peer.prototype)
  speedTest.phase = 'idle'
  speedTest.startedAt = 0
  speedTest.run = null
  speedTest.peers = []
  speedTest.swarm = { dht: { host: '8.8.8.8', port: 12_345 } }

  t.is(speedTest.snapshot().publicIP, '8.8.8.8:12345')
  speedTest.swarm.dht.host = null
  t.is(speedTest.snapshot().publicIP, null)
})

test('speed formatting always uses Mbps', (t) => {
  const model = new PeerModel({}, 'PUBLIC')
  model.result = {
    peers: [],
    downloadSpeed: 2_300_000 / 8,
    uploadSpeed: 655_400 / 8
  }

  const result = style.stripAnsi(model._resultView())
  t.ok(result.includes('↓ 2 Mbps'))
  t.ok(result.includes('↑ 0.6 Mbps'))

  model.result.downloadSpeed = 1_900_000_000 / 8
  t.ok(style.stripAnsi(model._resultView()).includes('↓ 1900 Mbps'))
  model.result.downloadSpeed = 50_000 / 8
  t.ok(style.stripAnsi(model._resultView()).includes('↓ 0.1 Mbps'))
})

test('a lower-latency arrival only replaces a fully idle peer', (t) => {
  const peers = Array.from({ length: MAX_PEERS }, (_, index) => {
    const peer = createPeer()
    peer.latency = index + 2
    peer.latencyStartedAt = index
    return peer
  })
  const speedTest = Object.create(Peer.prototype)
  speedTest.maxPeers = MAX_PEERS
  speedTest.peers = peers
  speedTest._update = () => {}
  const socket = { rawStream: { rtt: 1 } }
  const worst = peers[MAX_PEERS - 1]

  speedTest.run = {}
  t.absent(speedTest._acceptConnection(socket))
  t.absent(peers.some((peer) => peer.socket.destroyed))

  speedTest.run = null
  t.ok(speedTest._acceptConnection(socket))
  t.is(speedTest.peers.length, MAX_PEERS - 1)
  t.ok(worst.socket.destroyed)
  t.absent(worst.reconnecting)
})

test('partial idle commands have a deadline', (t) => {
  const peer = createPeer()
  peer.control = b4a.alloc(0)
  peer.deadline = null
  const speedTest = Object.create(Peer.prototype)
  speedTest.targetTimeout = 100
  speedTest.sessionTimeout = 200
  speedTest._update = () => {}

  speedTest._startServing(peer, DOWNLOAD.subarray(0, 1))

  t.ok(peer.deadline)
  clearTimeout(peer.deadline)
})

test('close tears down timers, peers, discovery, and swarm', async (t) => {
  let discoveryDestroyed = false
  let swarmDestroyed = false
  let unregistered = false
  let rejected = false
  const speedTest = Object.create(Peer.prototype)
  speedTest._testTimer = setTimeout(() => {}, 10_000)
  speedTest._reportTimer = setTimeout(() => {}, 10_000)
  speedTest._updateTimer = setInterval(() => {}, 10_000)
  speedTest._discoveryTimer = setInterval(() => {}, 10_000)
  speedTest.run = { reject: () => (rejected = true) }
  speedTest._unregister = () => (unregistered = true)
  speedTest.peers = [{ socket: { destroy() {} } }]
  speedTest.discovery = { destroy: () => Promise.resolve((discoveryDestroyed = true)) }
  speedTest.swarm = { destroy: () => (swarmDestroyed = true) }

  await speedTest._close()

  t.ok(unregistered)
  t.ok(rejected)
  t.ok(discoveryDestroyed)
  t.ok(swarmDestroyed)
  t.is(speedTest.phase, 'closed')
})

test('the peer table renders, truncates, and scrolls', (t) => {
  const model = new PeerModel({}, 'PUBLIC')
  t.is(model.peerTable.rows.length, 1)
  t.is(model.peerTable.height, 1)
  t.is(model.peerTable.rows[0][0], ' -')
  t.absent(model._footer().includes('Scroll'))
  model.snapshot.phase = 'idle'
  t.ok(model._phase().includes('Finding peers'))
  t.absent(model._phase().includes('0 peers'))
  t.absent(model._phase().includes('[ENTER]'))

  const ipv6 = 'fd00:0000:0000:0000:0000:0000:0000:0001'
  model.update({
    type: 'state',
    snapshot: {
      phase: 'idle',
      elapsed: 0,
      serving: [],
      peers: [createSnapshotPeer(ipv6)]
    }
  })
  t.is(model.peerTable.totalWidth, 45)
  t.is(model.serverLogTable.totalWidth, 29)
  t.ok(model.peerTable.rows[0][0].includes(ipv6))

  model.update({
    type: 'state',
    snapshot: {
      phase: 'idle',
      elapsed: 0,
      serving: [],
      peers: Array.from({ length: 32 }, (_, index) =>
        createSnapshotPeer(`127.0.0.${index + 1}`, 32 - index, 1000 + index)
      )
    }
  })
  model.update({ type: 'resize', width: 80, height: 18 })
  for (let i = 0; i < 5; i++) model.update(new KeyMsg({ name: 'down' }))

  t.is(model.peerTable.rows.length, 32)
  t.is(model.peerTable.height, 1)
  t.is(model.bar.width, 44)
  t.ok(model.peerTable.rows[0][0].includes('127.0.0.32'))
  t.ok(model.peerTable.rows[31][0].includes('127.0.0.1'))
  t.ok(model.peerTable.rows[0][0].includes(':1031'))
  t.ok(model.peerTable.rows[0][0].includes('\x1b[37m127.0.0.32\x1b[0m'))
  t.ok(model.peerTable.rows[0][0].includes('\x1b[90m:1031\x1b[0m'))
  t.is(model.peerTable.selectedRow(), null)
  t.absent(model.peerTable.view().includes('\x1b[7m'))
  t.is(model.peerTable.offset, 5)
  model.update(new KeyMsg({ name: 'up' }))
  t.is(model.peerTable.offset, 4)
  model.update(new KeyMsg({ name: 'down' }))
  t.is(model.peerTable.offset, 5)
  const ready = model._phase()
  t.is(ready, '32 peers')
  t.absent(ready.includes('Ready'))
  t.ok(model._actions().includes('[ENTER] Start test'))
  t.absent(model._actions().includes('Scroll'))
  t.ok(style.stripAnsi(model._footer()).endsWith('[q] Quit [↑/↓] Scroll · [TAB] Switch table'))
  t.ok(model._footer().includes('\x1b[2m[↑/↓] Scroll ·\x1b[0m'))
  t.ok(model._footer().includes('\x1b[37m[TAB]\x1b[0m'))
  t.ok(model._footer().includes('\x1b[90mSwitch table\x1b[0m'))
  t.absent(model._actions().includes('🔥'))
  t.absent(model._actions().includes('\x1b[1;'))
  t.ok(model._actions().includes('\x1b[38;2;255;213;79m'))
  model.spinner.tag = 5
  t.ok(model._actions().includes('\x1b[38;2;255;213;79m'))
  model.spinner.tag = 6
  t.ok(model._actions().includes('\x1b[38;2;255;183;77m'))
  model.spinner.tag = 11
  t.ok(model._actions().includes('\x1b[38;2;255;183;77m'))
  model.spinner.tag = 12
  t.ok(model._actions().includes('\x1b[38;2;255;213;79m'))
  t.is(model.spinner.fps, 6)
  const view = model.view().split('\n')
  t.is(model.peerTable.columns[0].title, '›↑↓Peer')
  t.is(model.serverLogTable.columns[0].title, ' LEECHERS')
  t.is(view.length, 18)
  t.ok(
    view[1].includes('🍐 PEAR SPEED') && view[1].includes('Lobby:') && view[1].includes('PUBLIC')
  )
  t.ok(view[1].includes('\x1b[90m·\x1b[0m'))
  t.ok(view.join('\n').includes('Peer'))
  t.absent(view.join('\n').includes('IP address'))
  t.absent(view.join('\n').includes('P2P speed test'))
  const privateView = new PeerModel({}, 'any secret').view()
  t.ok(privateView.includes('any secret'))
  t.absent(privateView.includes('🔒'))
  t.ok(style.stripAnsi(view[16]).includes('[q] Quit'))
  t.ok(style.stripAnsi(view[16]).includes('whoami: ⠋'))
  t.absent(view[16].includes('[ENTER]'))
  t.is(view[17], '')
  const loadingQuitColumn = style.width(style.stripAnsi(model._footer()).split('[q]')[0])
  model.snapshot.publicIP = '8.8.8.8'
  t.ok(model._footer().includes('\x1b[37mwhoami:\x1b[0m'))
  t.ok(model._footer().includes('\x1b[90m8.8.8.8'))
  t.ok(model._footer().includes('\x1b[37m[q]\x1b[0m'))
  t.ok(model._footer().includes('\x1b[90mQuit\x1b[0m'))
  t.is(style.width(style.stripAnsi(model._footer()).split('[q]')[0]), loadingQuitColumn)
  model.snapshot.publicIP = '181.91.85.51:123456'
  t.is(
    style.stripAnsi(model._footer()),
    'whoami: 181.91.85.51:123456     [q] Quit [↑/↓] Scroll · [TAB] Switch table'
  )
  const resultRow = view.findIndex((row) => row.includes('TOTAL'))
  t.is(view[resultRow + 1].trim(), '')
  t.is(view[resultRow + 2].trim(), '')
  t.ok(view[resultRow + 3].includes('[ENTER]'))
  t.ok(finalView(model).includes('0%'))
  t.absent(finalView(model).includes('100%'))
  model.result = { peers: [{}, {}] }
  const completed = model._phase()
  t.is(completed, 'Completed · 2 peers')
  t.is(style.stripAnsi(model._actions()), '→ Press [ENTER] to test')
  model.spinner.tag = 1
  t.ok(model._actions().includes('\x1b[38;2;255;213;79m'))
  model.spinner.tag = 2
  t.ok(model._actions().includes('\x1b[38;2;255;183;77m'))
  model.spinner.tag = 4
  t.ok(model._actions().includes('\x1b[38;2;255;213;79m'))
  t.ok(model.view().includes('100%'))
  const completedView = model.view().split('\n')
  const completedRow = completedView.findIndex((row) => row.includes('Completed'))
  t.is(completedView[completedRow - 1].trim(), '')
  t.is(completedView[completedRow - 2].trim(), '')
  t.ok(finalView(model).startsWith('\x1b[H\x1b[2J\n  Completed · 2 peers\n'))
  t.ok(finalView(model).includes('100%'))
  t.ok(finalView(model).includes('TOTAL'))
  t.ok(finalView(model).endsWith('\n\n'))
  model.snapshot.phase = 'download'
  model.snapshot.peers = [model.snapshot.peers[0]]
  t.ok(model._phase().includes('· 1 peer ·'))
  t.absent(model._actions().includes('[ENTER]'))
  model._quit()
  const exiting = model.view().split('\n')
  t.is(exiting.length, 18)
  t.is(exiting[1], '  Quitting...')
  t.absent(exiting.join('\n').includes('Peer'))
  t.absent(exiting.join('\n').includes('[q] Quit'))
})

test('small screens do not wrap or duplicate the restart action', (t) => {
  const model = new PeerModel({}, 'PUBLIC')
  const timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime()
  model.update({
    type: 'state',
    snapshot: {
      phase: 'idle',
      elapsed: 0,
      publicIP: '181.91.85.51',
      serving: [],
      peers: Array.from({ length: 12 }, (_, index) =>
        createSnapshotPeer(`127.0.0.${index + 1}`, index + 1)
      )
    }
  })
  for (let i = 0; i < 12; i++) {
    model.update({ type: 'served', entry: { timestamp, ip: `10.0.0.${i}` } })
  }
  model.result = { peers: [{}] }

  for (const [width, height] of [
    [40, 8],
    [50, 10],
    [55, 14],
    [60, 17]
  ]) {
    model.update({ type: 'resize', width, height })
    const lines = model.view().split('\n')
    t.is(lines.length, height)
    t.ok(lines.every((line) => style.width(line) <= width))
    t.is(
      lines.filter((line) => style.stripAnsi(line).includes('→ Press [ENTER] to test')).length,
      1
    )
  }
})

test('the server log records completed tests and remains bounded', (t) => {
  const model = new PeerModel({}, 'PUBLIC')
  const timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime()
  model.update({ type: 'resize', width: 150, height: 24 })
  t.is(model.peerTable.columns[0].width, 26)
  t.is(model.peerTable.columns[0].title, ' Peer')
  t.is(model.peerTable.totalWidth, 87)
  t.is(model.serverLogTable.totalWidth, 57)
  t.is(model.serverLogTable.columns[0].title, ' LEECHERS')
  t.alike(model.serverLogTable.rows, [[' -']])
  t.is(style.width(model.view()), 150)
  t.is(model.peerTable.columns[0].title, '›Peer')
  t.is(model.serverLogTable.columns[0].title, ' LEECHERS')
  const header = model
    .view()
    .split('\n')
    .find((line) => line.includes(' LEECHERS'))
  t.ok(header)
  t.ok(header.indexOf('Peer') < header.indexOf(' LEECHERS'))
  t.absent(header.includes('TIME'))
  t.ok(style.stripAnsi(header).endsWith('  '))
  t.ok(model.view().includes(' LEECHERS'))
  t.absent(model.view().includes('SERVER LOGS'))
  t.is(model.peerTable.height, 1)
  t.is(model.serverLogTable.height, 1)

  model.update({
    type: 'state',
    snapshot: {
      phase: 'idle',
      elapsed: 0,
      serving: [{ timestamp, ip: '192.168.100.42', port: 12345 }],
      peers: []
    }
  })
  t.is(
    style.stripAnsi(model.serverLogTable.rows[0][0]),
    ' 2026-01-02 03:04:05 → 🏠 192.168.100.42:12345 ⠋'
  )
  const servingRow = model.serverLogTable.rows[0][0]
  t.ok(servingRow.includes('\x1b[38;2;0;217;163m'))
  t.absent(servingRow.includes('\x1b[37m'))
  t.absent(servingRow.includes('\x1b[90m'))

  model.update({
    type: 'state',
    snapshot: { phase: 'idle', elapsed: 0, serving: [], peers: [] }
  })
  model.update({ type: 'served', entry: { timestamp, ip: '192.168.100.42', port: 12345 } })
  t.ok(model.serverLogTable.rows[0][0].includes('2026-01-02 03:04:05'))
  t.ok(model.serverLogTable.rows[0][0].includes(' → '))
  t.ok(style.stripAnsi(model.serverLogTable.rows[0][0]).includes('🏠 192.168.100.42:12345'))
  t.ok(model.serverLogTable.rows[0][0].includes(':12345'))
  t.ok(model.serverLogTable.rows[0][0].includes('\x1b[37m192.168.100.42\x1b[0m'))
  t.ok(model.serverLogTable.rows[0][0].includes('\x1b[90m:12345\x1b[0m'))
  t.ok(model.serverLogTable.rows[0][0].includes('\x1b[90m'))
  t.is(model.serverLogTable.selectedRow(), null)
  t.ok(model.serverLogTable.rows[0][0].includes('192.168.100.42'))

  for (let i = 0; i < 100; i++) {
    model.update({ type: 'served', entry: { timestamp, ip: `10.0.0.${i}`, port: 10000 + i } })
  }
  t.is(model.serverLogs.length, 100)
  t.is(model.serverLogs[99].ip, '10.0.0.99')
  t.ok(
    style
      .stripAnsi(model.serverLogTable.rows[model.serverLogTable.rows.length - 1][0])
      .includes('🏠 10.0.0.99:10099')
  )
  t.is(model.peerTable.height, 1)
  t.is(model.serverLogTable.height, 15)
  const independentView = style.stripAnsi(model.view()).split('\n')
  t.is(model.peerTable.columns[0].title, '›Peer')
  t.is(model.serverLogTable.columns[0].title, ' ↓LEECHERS')
  t.ok(
    independentView.findIndex((row) => row.includes('Finding peers')) <
      independentView.findIndex((row) => row.includes('10.0.0.10'))
  )
  model.update({
    type: 'state',
    snapshot: {
      phase: 'idle',
      elapsed: 0,
      serving: [
        { timestamp, ip: '192.168.100.42', port: 12345 },
        { timestamp, ip: '192.168.100.43', port: 12346 },
        { timestamp, ip: '192.168.100.44', port: 12347 }
      ],
      peers: Array.from({ length: 32 }, (_, index) =>
        createSnapshotPeer(`127.0.0.${index + 1}`, index + 1, 20000 + index)
      )
    }
  })
  t.is(model.peerTable.height, 7)
  t.is(model.serverLogTable.height, 15)
  t.is(model.serverLogTable.rows.length, 103)
  model.view()
  t.is(model.peerTable.columns[0].title, '›↓Peer')
  t.is(model.serverLogTable.columns[0].title, ' ↓LEECHERS')
  for (const [ip, port] of [
    ['192.168.100.42', 12345],
    ['192.168.100.43', 12346],
    ['192.168.100.44', 12347]
  ]) {
    const row = model.serverLogTable.rows.find((row) => row[0].includes(ip))[0]
    t.ok(row.includes('\x1b[38;2;0;217;163m'))
    t.ok(style.stripAnsi(row).includes(`${ip}:${port}`))
    t.ok(style.stripAnsi(row).endsWith(' ⠋'))
  }
  model.update(new KeyMsg({ name: 'down' }))
  t.is(model.peerTable.offset, 1)
  t.is(model.serverLogTable.offset, 0)
  model.view()
  t.is(model.peerTable.columns[0].title, '›↑↓Peer')
  model.update(new KeyMsg({ name: 'tab' }))
  model.view()
  t.is(model.peerTable.columns[0].title, ' ↑↓Peer')
  t.is(model.serverLogTable.columns[0].title, '›↓LEECHERS')
  model.update(new KeyMsg({ name: 'down' }))
  t.is(model.serverLogTable.offset, 1)
  t.is(model.peerTable.offset, 1)
  model.view()
  t.is(model.serverLogTable.columns[0].title, '›↑↓LEECHERS')
  model.update(new KeyMsg({ name: 'up' }))
  t.is(model.serverLogTable.offset, 0)
  model.update(new KeyMsg({ name: 'end' }))
  t.is(model.serverLogTable.offset, 103 - model.serverLogTable.height)
  t.is(model.serverLogTable.selectedRow(), null)
  model.view()
  t.is(model.serverLogTable.columns[0].title, '›↑LEECHERS')
})

test('four peers test together, serve concurrently, and repeat', { timeout: 20_000 }, async (t) => {
  const testnet = await createTestnet(3)
  const topic = b4a.from(randomBytes(32))
  const peers = Array.from(
    { length: 4 },
    () =>
      new Peer(topic, {
        bootstrap: testnet.bootstrap,
        phaseDuration: 200,
        reportTimeout: 1_000,
        targetTimeout: 2_000,
        sessionTimeout: 2_000,
        discoveryInterval: 100
      })
  )
  t.teardown(async () => {
    await Promise.all(peers.map((peer) => peer.close()))
    await testnet.destroy()
  })

  await Promise.all(peers.map((peer) => peer.open()))
  await waitFor(() => peers.every((peer) => peer.snapshot().peers.length === 3))
  t.is(peers[0].phase, 'idle')

  const served = []
  peers[3].on('served', (entry) => served.push(entry))
  const first = peers[0].test()
  await waitFor(() => peers[1].snapshot().serving.length === 1)
  t.is(typeof peers[1].snapshot().serving[0].timestamp, 'number')
  t.is(typeof peers[1].snapshot().serving[0].ip, 'string')
  const concurrent = peers[1].test()
  t.is(peers[1].snapshot().peers.length, 2)
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent])

  t.is(firstResult.peers.length, 3)
  t.is(concurrentResult.peers.length, 2)
  t.ok(firstResult.verified)
  t.ok(concurrentResult.verified)
  t.ok(served.length >= 2)
  t.ok(
    served.every((entry) => Number.isSafeInteger(entry.timestamp) && typeof entry.ip === 'string')
  )

  await waitFor(() => peers[0].snapshot().peers.every((peer) => peer.available))
  const repeated = await peers[0].test()
  t.is(repeated.peers.length, 3)
  t.ok(repeated.verified)
  t.ok(repeated.downloadSpeed > 0)
  t.ok(repeated.uploadSpeed > 0)
})

function createReceiptTest() {
  const peer = createPeer('verifying')
  peer.done = false
  peer.report = b4a.alloc(0)
  const speedTest = Object.create(Peer.prototype)
  speedTest.run = { targets: [peer] }
  speedTest._update = () => {}
  return { speedTest, peer }
}

function createPeer(mode = 'idle') {
  const peer = {
    ready: true,
    mode,
    dropping: false,
    control: b4a.alloc(0),
    latency: 1,
    latencyStartedAt: 0,
    socket: {
      writes: [],
      destroyed: false,
      write(data) {
        this.writes.push(data)
        return true
      },
      destroy() {
        this.destroyed = true
      }
    }
  }
  peer.info = { reconnect: (value) => (peer.reconnecting = value) }
  return peer
}

function createSnapshotPeer(ip, latency = 1, port = 0) {
  return {
    ip,
    port,
    latency,
    downloaded: 0,
    uploaded: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    available: true,
    failed: false
  }
}

async function waitFor(condition, timeout = 10_000) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for peers')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
