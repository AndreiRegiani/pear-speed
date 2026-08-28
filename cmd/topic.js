'use strict'

const id = require('hypercore-id-encoding')

module.exports = function parseTopic(value) {
  if (typeof value !== 'string' || value.length !== 52) {
    throw new Error('--lobby must be a 52-character z32 topic')
  }
  try {
    return id.decode(value)
  } catch {
    throw new Error('--lobby must be a 52-character z32 topic')
  }
}
