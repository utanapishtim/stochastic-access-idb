const util = require('util')
const test = require('tape')
const RAM = require('random-access-memory')
const b4a = require('b4a')
const randombytes = require('randombytes')
const RAI = require('../')

/**
 * 
 * perform a rai instance of some size and a ram instance
 * perform a random number of writes to both instances
 * ensure both instances are equivalent
 * 
 * - del = offset, size
 * - write = offset, data
 * - read = offset, size
 */

test('random', function (t) {
  const size = sample(1, Math.pow(1024, sample(1, 2))) // page size

  const rai = new RAI('test', { size })
  const ram = new RAM({ pageSize: size })

  const max = sample(size, size * 100) // max size of storage
  const wnum = sample(10, 100) // number of random write ops
  const rnum = sample(1, 3) // number of random read ops per write

  const plan = (wnum * (rnum + 1)) + 1
  t.plan(plan)

  wnext(wnum)

  function onfinished () {
    const maxidx = Math.floor((rai.length - 1) / rai.size)
    const eql = []
    rnext(0)

    function rnext (idx) {
      if (idx > maxidx) return t.ok(eql.every(Boolean))
      const bufs = []

      rai.read(idx, size, onread)
      ram.read(idx, size, onread)

      function onread (err, buf) {
        if (err) return t.fail(err.message)
        bufs.push(buf)
        if (bufs.length < 2) return
        eql.push(!b4a.compare(...bufs))
        return rnext(idx + 1)
      }
    }
  }
  
  function wnext (i) {
    if (i === 0) return onfinished()
    const offset = sample(0, max - 1)
    const size = sample(0, (max - 1) - offset)
    const data = randombytes(size)

    let ws = 2 // pending writes

    rai.write(offset, data, onwrite)
    ram.write(offset, data, onwrite)

    function onwrite (err) {
      if (err) return t.fail(err.message)
      if (--ws > 0) return
      t.equals(rai.length, ram.length)
      rnext(rnum)

      function rnext (j) {
        if (j === 0) return wnext(i - 1)
        const offset = sample(0, rai.length - 1)
        const size = sample(1, (rai.length - 1) - offset)
        let bufs = []
        rai.read(offset, size, onread)
        ram.read(offset, size, onread)

        function onread (err, buf) {
          if (err) return t.fail(err.message)
          bufs.push(buf)
          if (bufs.length < 2) return
          t.ok(b4a.compare(...bufs) === 0)
          return rnext(j - 1)
        }
      }
    }
  }
})

let exitCode = 0
test.onFailure(function () {
  exitCode = 1
})

test.onFinish(function () {
  window && window.close()
  process.exit(exitCode)
})


function sample (min, max) {
  if (min > max) {
    const tmp = max
    max = min
    min = tmp
  }
  return Math.floor(Math.random() * (max - min + 1) + min)
}