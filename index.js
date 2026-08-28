#!/usr/bin/env bare

'use strict'

const process = require('bare-process')
const main = require('./cmd')

main(process.argv.slice(2))
