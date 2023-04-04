const randombytes = require('randombytes')
const LegacyRAI = require('random-access-idb')('dbname')
const hdr = require('hdr-histogram-js')
const { storage, teardown: _teardown, write } = require('../test/helpers')

const teardown = (e) => {
  if (e) console.log(e)
  setImmediate(_teardown())
}

run().then(teardown, teardown)

async function run () {
  for (let s = 1024; s < (1024 * 10); s = s + 1024) {
    const total = Math.floor((1000 * 1024) / s)
    await test(total, s)
  }
}

async function test (total, size) {
  const bufs = []
  while (bufs.length < total) bufs.push(randombytes(size))
  const baseline = LegacyRAI('test')
  const next = storage('test', { size: 4096 })
  const stores = [baseline, next]
  const t = { spanning: size > 4096, total, size, backends: ['baseline', 'next'], durations: [], summary: {} }
  const summaries = []
  for (const i in stores) {
    console.log('running', t.backends[i], '...')
    const store = stores[i]
    const start = Date.now()
    const histogram = hdr.build()
    for (const i in bufs) {
      const ts = Date.now()
      await write(store, i * size, bufs[i]).then(() => histogram.recordValue(Date.now() - ts))
    }
    t.durations[i] = Date.now() - start
    summaries[i] = histogram.summary
  }

  const [summary] = summaries
  for (const key in summary) t.summary[key] = [summaries[0][key], summaries[1][key]]
  console.log(JSON.stringify(t, null, 2))
}
