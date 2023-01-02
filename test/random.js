const util = require('util')
const test = require('tape')
const RAM = require('random-access-memory')
const b4a = require('b4a')
const randombytes = require('randombytes')
const RAI = require('../')

test('random writes and reads', function (t) {
  const size = sample(1, Math.pow(1024, sample(1, 2))) // random page size

  const rai = new RAI('test', { size })
  const ram = new RAM({ pageSize: size })

  const max = sample(size, size * 100) // max bytes written to storage, <= 2
  const wnum = sample(10, 100) // number of random write ops
  const rnum = sample(1, 3) // number of random read ops per write

  t.plan((wnum * (rnum + 1)) + 1)

  wnext(wnum) // trigger first random write

  function onfinished () {
    const maxidx = Math.floor((rai.length - 1) / rai.size)
    const eql = []
    rnext(0)

    // reads every page from both stores and compares them
    function rnext (idx) {
      if (idx > maxidx) return t.ok(eql.every(Boolean)) // all pages should be identical
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
  
  // next random write (write wnum - i of wnum)
  function wnext (i) {
    if (i === 0) return onfinished() // trigger final comparison
    const offset = sample(0, max - 1) // random offset to write from
    const size = sample(0, (max - 1) - offset) // random num of bytes to write
    const data = randombytes(size) // random bytes

    let ws = 2 // pending writes

    rai.write(offset, data, onwrite)
    ram.write(offset, data, onwrite)

    function onwrite (err) {
      if (err) return t.fail(err.message)
      if (--ws > 0) return
      t.equals(rai.length, ram.length)
      rnext(rnum) // trigger random reads

      // next random read (read rnum - j of rnum)
      function rnext (j) {
        if (j === 0) return wnext(i - 1)
        const offset = sample(0, rai.length - 1) // random offset to read from
        const size = sample(1, (rai.length - 1) - offset) // random num of bytes to read
        let bufs = [] // uses buf length to track pending reads
        rai.read(offset, size, onread)
        ram.read(offset, size, onread)

        function onread (err, buf) {
          if (err) return t.fail(err.message)
          bufs.push(buf)
          if (bufs.length < 2) return
          t.ok(b4a.compare(...bufs) === 0) // should randomly read identical bytes
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