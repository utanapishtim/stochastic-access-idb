const b4a = require('b4a')
const test = require('brittle')

const { storage, write, read, del, teardown } = require('./helpers')

test('simple', async function (t) {
  t.teardown(teardown())

  const cool = storage('cool.txt', { size: 5 })
  t.is(cool.name, 'cool.txt')
  await write(cool, 100, b4a.from('GREETINGS'))
  const fstbuf = await read(cool, 100, 9)
  t.is(b4a.toString(fstbuf, 'utf-8'), 'GREETINGS')
  const sndbuf = await read(cool, 104, 3)
  t.is(b4a.toString(sndbuf, 'utf-8'), 'TIN')
  await del(cool, 104, 5)
  await t.exception(() => read(cool, 104, 3))
})
