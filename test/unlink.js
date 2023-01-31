const test = require('brittle')
const randombytes = require('randombytes')
const RAI = require('../')
const { teardown, storage, sample, write, close, open, unlink } = require('./helpers')

test('unlink', async function (t) {
  t.teardown(teardown())

  const buf = randombytes(sample(1, 1024 * 4))
  let rai = storage('test', { size: 1024 })
  await write(rai, 0, buf)
  const len = rai.length
  await close(rai)
  console.log('closed first instance')
  rai = new RAI(rai.name, { dbname: rai.dbname, size: rai.size })
  await open(rai)
  console.log('opening second instance')
  t.is(rai.length, len)
  await unlink(rai)
  rai = new RAI(rai.name, { dbname: rai.dbname, size: rai.size })
  await open(rai)
  t.ok(len !== rai.length)
  t.is(rai.length, 0)
})