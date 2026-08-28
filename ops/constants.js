'use strict'

const b4a = require('b4a')
const env = require('bare-env')

const DURATION = 16_000

module.exports = {
  TOPIC: b4a.from('b9ab3c2e9d5148a2291137aad40650c975e313d5d6ad061da5584433cee06985', 'hex'),
  START: b4a.from('pear-speed/2'),
  READY: b4a.from('pear-speed/ready'),
  DOWNLOAD: b4a.from('pear-speed/download'),
  UPLOAD: b4a.from('pear-speed/upload'),
  STOP: b4a.from('pear-speed/stop'),
  DATA: b4a.alloc(64 * 1024),
  PEERS: 5,
  MAX_PEERS: 64,
  CONNECTIONS: 1,
  DURATION,
  PHASE_DURATION: DURATION / 2,
  REPORT_TIMEOUT: 10_000,
  DISCOVERY_INTERVAL: 2_000,
  SELECTION_DELAY: 5_000,
  TARGET_TIMEOUT: 10_000,
  SESSION_TIMEOUT: 30_000,
  MAX_REPORT: 1024,
  BOOTSTRAP: env.PEAR_SPEED_BOOTSTRAP ? env.PEAR_SPEED_BOOTSTRAP.split(',') : undefined
}
