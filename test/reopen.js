const b4a = require('b4a')
const test = require('brittle')
const randombytes = require('randombytes')
const RAM = require('random-access-memory')
const RAI = require('..')
const { sample, write, read, del, truncate, close, open } = require('./helpers')

const size = 1024
const storage = (name = `name-${Math.random()}`, opts = {}) => new RAI({ prefix: `prefix-${Math.random()}`, name, size, ...opts })

test('reopen', async function (t) {
  t.test('reopen', async function (t) {
    const size = sample(1, 1024 * sample(1, 8))
    let rai = storage('test', { size })
    const ram = new RAM({ pageSize: size })
    const max = sample(size, size * 10) // max bytes written to storage
    const wnum = sample(1, 10) // number of random write ops
    const rnum = sample(1, 3) // number of random read ops per write
    
    const reopenMaybe = async () => {
      console.log('reopen maybe...')
      if (Math.random() <= 0.75) {
        console.log('early return')
        return rai
      }
      console.log('closing', rai.length)
      await (new Promise((res) => setTimeout(res, 1000)))
      // await (new Promise((res, rej) => rai.close((e, d) => (e) ? rej(e) : res(d))))
      console.log('reopening')
      const _rai = new RAI(rai.name, { prefix: rai.prefix, size: rai.size })
      console.log('opening')
      await (new Promise((res, rej) => _rai.open((e, d) => (e) ? rej(e) : res(d))))
      console.log('opened', _rai.length)
      return new Promise((res) => setImmediate(res, _rai))
    }

    for (let i = 0; i < wnum; i++) {
      rai = await reopenMaybe()
      console.log('finished...')
      console.log('continuing...')
      console.log('lens prewrite', rai.length, ram.length, rai.size)
      const offset = sample(0, max - 1) // random offset to write from
      const size = sample(0, (max - 1) - offset) // random num of bytes to write
      const data = randombytes(size) // random bytes
      await Promise.all([write(rai, offset, data), write(ram, offset, data)])
      console.log('lens postwrite', rai.length, ram.length)
      t.is(rai.length, ram.length)
      for (let j = 0; j < rnum; j++) {
        // const rai = await reopenMaybe()
        const offset = sample(0, rai.length - 1) // random offset to read from
        const size = sample(1, (rai.length - 1) - offset) // random num of bytes to read
        const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
        t.ok(!b4a.compare(...bufs))
      }
    }

    const maxpage = Math.floor((rai.length - 1) / size)
    for (let page = 0; page < maxpage; page++) {
      // const rai = await reopenMaybe()
      const offset = page * size
      const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
      t.ok(!b4a.compare(...bufs))
    }
  })
}).catch((err) => console.error(err))
  