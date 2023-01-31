const b4a = require('b4a')
const test = require('brittle')
const randombytes = require('randombytes')
const { sample, write, read, del, truncate, teardown, storage } = require('./helpers')

test('del', function (t) {
  t.teardown(teardown())

  t.test('it should do nothing if randomly deleting zero bytes', async function (t) {
    t.plan(3)
    const rai = storage()
    const size = rai.size
    const pages = [randombytes(size), randombytes(size), randombytes(size)]
    for (const i in pages) await write(rai, i * size, pages[i])
    await del(rai, sample(0, rai.length - 1), 0)
    for (const j in pages) {
      const buf = await read(rai, j * size, size)
      console.log()
      t.ok(!b4a.compare(buf, pages[j]))
    }
  })

  t.test('it should punch a hole in a single page', async function (t) {
    t.plan(3)
    const rai = storage()
    const size = rai.size
    const pages = [randombytes(size), randombytes(size), randombytes(size)]
    for (const i in pages) await write(rai, i * size, pages[i])

    const l = rai.length // total bytes written
    const o = sample(0, l - 2) // random offset
    const p = Math.floor(o / size) // page index
    const idx = o - (p * size) // relative index in page
    const tail = size - idx // num bytes in page to the right of the index
    const s = sample(0, tail) // num bytes to operate on
    const page = pages[p] // raw bytes in page

    const fstbuf = await read(rai, o, s)
    const data = b4a.alloc(s)

    b4a.copy(page, data, 0, idx, idx + s)
    t.ok(!b4a.compare(data, fstbuf))

    await del(rai, o, s)
    const sndbuf = await read(rai, o, s)
    const zeros = b4a.fill(b4a.alloc(s), 0)
    t.ok(b4a.compare(data, sndbuf))
    t.ok(!b4a.compare(zeros, sndbuf))
  })

  t.test('it should punch a hole in multiple pages', async function (t) {
    t.plan(3)
    const rai = storage()
    const size = rai.size
    const pages = [randombytes(size), randombytes(size), randombytes(size)]
    for (const i in pages) await write(rai, i * size, pages[i])

    const l = rai.length
    // bounds of operation as offsets into storage
    const ofst = sample(0, size - 1)
    const olst = sample(size, l - 2)
    // respective pages offsets map to
    const pfst = Math.floor(ofst / size)
    const plst = Math.floor(olst / size)
    // relative index of offsets in respective pages
    const ifst = ofst - (pfst * size)
    const ilst = olst - (plst * size)
    // size of operation in bytes
    const s = olst - ofst

    let start = 0
    const data = b4a.alloc(s)
    for (let p = pfst; p <= plst; p++) {
      if (p === pfst) {
        b4a.copy(pages[p], data, start, ifst, size)
        start += size - ifst
      } else if (p === plst) {
        b4a.copy(pages[p], data, start, 0, ilst)
      } else {
        b4a.copy(pages[p], data, start, 0, size)
        start += size
      }
    }

    const fstbuf = await read(rai, ofst, s)
    t.ok(!b4a.compare(data, fstbuf))

    await del(rai, ofst, s)
    const sndbuf = await read(rai, ofst, s)
    const zeros = b4a.fill(b4a.alloc(s), 0)

    t.ok(b4a.compare(data, sndbuf))
    t.ok(!b4a.compare(zeros, sndbuf))
  })

  t.test('it should delete to end of storage', async function (t) {
    t.plan(3)
    const rai = storage()
    const size = rai.size
    const pages = [randombytes(size), randombytes(size), randombytes(size)]
    for (const i in pages) await write(rai, i * size, pages[i])

    const l = rai.length // total number of bytes in store
    const o = sample(0, l - 1) // absolute offset into storage
    const s = l - o // number of bytes from offset to end of storage
    const pidx = Math.floor(o / size) // index of page containing absolute offset
    const idx = o - (pidx * size) // page-relative index that maps to absolute offset

    let start = 0
    const data = b4a.alloc(s)
    for (let p = pidx; p <= pages.length - 1; p++) {
      if (p === pidx) {
        b4a.copy(pages[p], data, start, idx, size)
        start = size - idx
      } else {
        b4a.copy(pages[p], data, start, 0, size)
        start += size
      }
    }

    const fstbuf = await read(rai, o, s)
    t.ok(!b4a.compare(data, fstbuf))

    await del(rai, o, s)

    await t.exception(() => read(rai, o, s))
    t.is(rai.length, o)
  })

  t.test('it should be equivalent to delete to end of storage or truncate', async function (t) {
    t.plan(6)

    const rais = [storage(), storage()]
    const size = rais[0].size
    const pages = [randombytes(size), randombytes(size), randombytes(size)]

    for (const i in pages) {
      await Promise.all(rais.map((rai) => write(rai, i * size, pages[i])))
    }
    const [rai1, rai2] = rais

    t.is(rai1.length, rai2.length)
    t.ok(rai1.length > 0)

    const l = rai1.length
    const o = sample(0, l - 1)
    const s = l - o

    await del(rai1, o, s)
    await truncate(rai2, o)

    t.is(rai1.length, rai2.length)
    await t.exception(() => read(rai1, o, s))
    await t.exception(() => read(rai2, o, s))
    const buf1 = await read(rai1, 0, rai1.length)
    const buf2 = await read(rai2, 0, rai2.length)
    t.ok(!b4a.compare(buf1, buf2))
  })
})
