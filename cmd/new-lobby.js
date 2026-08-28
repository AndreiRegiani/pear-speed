'use strict'

const b4a = require('b4a')
const id = require('hypercore-id-encoding')
const { randomBytes } = require('bare-crypto')

module.exports = function newLobby() {
  console.log(`Generated unique topic: ${id.encode(b4a.from(randomBytes(32)))}`)
}
