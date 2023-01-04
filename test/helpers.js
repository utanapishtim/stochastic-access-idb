const util = require('util')
const b4a = require('b4a')

exports.promisify = function promisify (rai) {
  console.log('start')
  const fns = ['open', 'read', 'write', 'del', 'truncate', 'stat', 'suspend', 'close', 'unlink']
  const props = ['size', 'indexedDB', 'version', 'prefix', 'name', 'id', 'db', 'length', 'log']
  const iface = {}
  for (const fn of fns) {
    if (fn !== 'read') {
      iface[fn] = util.promisify(rai[fn].bind(rai))
      continue
    }
    iface[fn] = (o, s) => {
      return new Promise((resolve, reject) => {
        rai.read(o, s, (err, buf) => {
          if (err) {
            console.error('error', err)
            return reject(err)
          }
          console.log('buf')
          return resolve(buf)
        })
      })
    }
  }
  for (const prop of props) Object.assign(iface, { get [prop] () { return rai[prop] } })
  iface.rai = rai
  return iface
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
exports.close = (ras) => new Promise((res, rej) => ras.close((e, d) => (e) ? rej(e) : res(d)))
exports.open = (ras) => new Promise((res, rej) => ras.open((e, d) => (e) ? rej(e) : res(d)))