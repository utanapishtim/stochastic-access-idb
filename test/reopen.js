const b4a = require('b4a')
const test = require('brittle')
const randombytes = require('randombytes')
const RAM = require('random-access-memory')
const RAI = require('..')
const { sample, write, read, close, open, storage, teardown } = require('./helpers')

// this test differs from random.js in that it interleaves writes/reads
// and randomly closes and reopens the idb based storage some of the time
test('reopen', async function (t) {
  t.teardown(teardown())

  const size = sample(1, 1024 * sample(1, 8))
  let rai = RAI('test', { size })('test')
  const ram = new RAM({ pageSize: size })
  const max = sample(size, size * 10) // max bytes written to storage
  const wnum = sample(1, 10) // number of random write ops
  const rnum = sample(1, 3) // number of random read ops per write

  const reopenMaybe = async () => {
    if (Math.random() <= 0.75) return rai
    await close(rai)
    console.log('closed')
    const _rai = RAI('test', { size })('test')
    console.log('_rai', _rai)
    console.log('opening')
    await open(_rai)
    console.llg('opened')
    return _rai
  }

  for (let i = 0; i < wnum; i++) {
    rai = await reopenMaybe()
    const offset = sample(0, max - 1) // random offset to write from
    const size = sample(0, (max - 1) - offset) // random num of bytes to write
    const data = randombytes(size) // random bytes
    await Promise.all([write(rai, offset, data), write(ram, offset, data)])
    t.is(rai.length, ram.length)
    for (let j = 0; j < rnum; j++) {
      rai = await reopenMaybe()
      const offset = sample(0, Math.floor(0, rai.length - 1)) // random offset to read from
      const size = sample(1, (rai.length - 1) - offset) // random num of bytes to read
      const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
      t.ok(!b4a.compare(...bufs))
    }
  }

  const maxpage = Math.floor((rai.length - 1) / size)
  for (let page = 0; page < maxpage; page++) {
    rai = await reopenMaybe()
    const offset = page * size
    const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
    t.ok(!b4a.compare(...bufs))
  }
})
