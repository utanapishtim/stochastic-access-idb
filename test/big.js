const b4a = require('b4a')
const test = require('brittle')
const { write, read, storage, teardown } = require('./helpers')

test('big', async function (t) {
  t.teardown(teardown())
  const cool = storage('cool.txt', { size: 1024 })
  await write(cool, 32, b4a.from('GREETINGS', 'utf-8'))
  await write(cool, 32 + 3, b4a.from('AT SCOTT', 'utf-8'))
  const fstbuf = await read(cool, 32, 9)
  t.is(b4a.toString(fstbuf, 'utf-8'), 'GREAT SCO')
  const sndbuf = await read(cool, 32 + 6, 5)
  t.is(b4a.toString(sndbuf, 'utf-8'), 'SCOTT')
})
