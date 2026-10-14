'use strict'

const Corestore = require('corestore')
const FramedStream = require('framed-stream')
const Hyperswarm = require('hyperswarm')
const PearRuntime = require('pear-runtime')
const goodbye = require('graceful-goodbye')
const path = require('bare-path')
const storage = require('bare-storage')
const { isBareKit } = require('which-runtime')

const argv = (i) => Bare.argv[i + (isBareKit ? 0 : 2)]

const updates = argv(0) !== 'false'
const version = argv(1)
const upgrade = argv(2)
const name = argv(3)
const dir = argv(4) || storage.persistent()
const app = argv(5) || null

const pipe = new FramedStream(Bare.IPC)
const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
const swarm = new Hyperswarm()
const pear = new PearRuntime({ dir, updates, version, upgrade, name, app, store, swarm })

pear.updater.on('error', console.error)

if (updates) {
  swarm.on('connection', (conn) => store.replicate(conn))
  swarm.join(pear.updater.drive.core.discoveryKey, { client: true, server: false })
}

pear.updater.on('updating', () => pipe.write('updating'))
pear.updater.on('updated', () => pipe.write('updated'))

pipe.on('data', async (data) => {
  if (data.toString() !== 'pear:applyUpdate') return
  await pear.ready()
  await pear.updater.applyUpdate()
  pipe.write('pear:updateApplied')
})

goodbye(async () => {
  await swarm.destroy()
  await pear.close()
  await store.close()
})
