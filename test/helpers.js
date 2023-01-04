const util = require('util')
const RAI = require('../')

let count = 0
exports.teardown = () => {
  count++
  return () => {
    setImmediate(() => {
      if (--count > 0) return
      window && window.close()
      process.exit(0)
    })
  }
}

exports.storage = (name = `name-${Math.random()}`, opts = {}) => {
  return new RAI({ prefix: `prefix-${Math.random()}`, name, size: 1024, ...opts })
}

exports.sample = function sample (min, max) {
  if (min > max) {
    const tmp = max
    max = min
    min = tmp
  }
  return Math.floor(Math.random() * (max - min + 1) + min)
}

exports.write = (ras, o, b) => util.promisify(ras.write.bind(ras))(o, b)
exports.read = (ras, o, s) => util.promisify(ras.read.bind(ras))(o, s)
exports.del = (ras, o, s) => util.promisify(ras.del.bind(ras))(o, s)
exports.truncate = (ras, o) => util.promisify(ras.truncate.bind(ras))(o)
exports.close = (ras) => util.promisify(ras.close.bind(ras))()
exports.open = (ras) => util.promisify(ras.open.bind(ras))()
