const b4a = require('b4a')
const test = require('brittle')
const randombytes = require('randombytes')
const RAM = require('random-access-memory')
const { sample, write, read, storage, teardown } = require('./helpers')

test('random', async function (t) {
  t.teardown(teardown())

  const size = sample(1, Math.pow(1024, sample(1, 2)))
  const rai = storage('test', { size })
  const ram = new RAM({ pageSize: size })
  const max = sample(size, size * 100) // max bytes written to storage
  const wnum = sample(10, 100) // number of random write ops
  const rnum = sample(1, 3) // number of random read ops per write

  for (let i = 0; i < wnum; i++) {
    const offset = sample(0, max - 1) // random offset to write from
    const size = sample(0, (max - 1) - offset) // random num of bytes to write
    const data = randombytes(size) // random bytes
    await Promise.all([write(rai, offset, data), write(ram, offset, data)])
    t.is(rai.length, ram.length)
    for (let j = 0; j < rnum; j++) {
      const offset = sample(0, rai.length - 1) // random offset to read from
      const size = sample(1, (rai.length - 1) - offset) // random num of bytes to read
      const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
      t.ok(!b4a.compare(...bufs))
    }
  }

  const maxpage = Math.floor((rai.length - 1) / size)
  for (let page = 0; page < maxpage; page++) {
    const offset = page * size
    const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
    t.ok(!b4a.compare(...bufs))
  }
})
