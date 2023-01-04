const b4a = require('b4a')
const test = require('brittle')
const randombytes = require('randombytes')
const RAM = require('random-access-memory')
const RAI = require('..')
const { sample, write, read, del, truncate, close } = require('./helpers')

const size = 1024
const storage = (name = `name-${Math.random()}`, opts = {}) => new RAI({ prefix: `prefix-${Math.random()}`, name, size, ...opts })

test('ops', function (t) {
  t.teardown(() => {
    setImmediate(() => {
      window && window.close()
      process.exit(0)
    })
  })

  t.test('simple', async function (t) {
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

  t.test('random', async function (t) {
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
  }).catch((err) => {
    console.error('random', err)
    process.exit(0)
  })

  // this test differs from random.js in that it interleaves writes/reads
  // and randomly reopens the idb based storage some of the time
  // t.test('reopen', async function (t) {
  //   const size = sample(1, Math.pow(1024, sample(1, 2)))
  //   let rai = storage('test', { size })
  //   const ram = new RAM({ pageSize: size })
  //   const max = sample(size, size * 100) // max bytes written to storage
  //   const wnum = sample(10, 100) // number of random write ops
  //   const rnum = sample(1, 3) // number of random read ops per write

  //   const reopenMaybe = async () => {
  //     if (Math.random() <= 0.75) return rai
  //     console.log('reopen')
  //     return new RAI(rai.name, { prefix: rai.prefix })
  //   }

  //   for (let i = 0; i < wnum; i++) {
  //     rai = await reopenMaybe()
  //     const offset = sample(0, max - 1) // random offset to write from
  //     const size = sample(0, (max - 1) - offset) // random num of bytes to write
  //     const data = randombytes(size) // random bytes
  //     await Promise.all([write(rai, offset, data), write(ram, offset, data)])
  //     t.is(rai.length, ram.length)
  //     for (let j = 0; j < rnum; j++) {
  //       rai = await reopenMaybe()
  //       const offset = sample(0, rai.length - 1) // random offset to read from
  //       const size = sample(1, (rai.length - 1) - offset) // random num of bytes to read
  //       const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
  //       t.ok(!b4a.compare(...bufs))
  //     }
  //   }

  //   const maxpage = Math.floor((rai.length - 1) / size)
  //   for (let page = 0; page < maxpage; page++) {
  //     rai = await reopenMaybe()
  //     const offset = page * size
  //     const bufs = await Promise.all([read(rai, offset, size), read(ram, offset, size)])
  //     t.ok(!b4a.compare(...bufs))
  //   }
  // }).catch((err) => {
  //   console.error('reopen', err)
  //   process.exit(0)
  // })

  t.test('del', function (t) {
    t.test('it should do nothing if randomly deleting zero bytes', async function (t) {
      t.plan(3)
      const pages = [randombytes(size), randombytes(size), randombytes(size)]
      const rai = storage()
      for (let i in pages) await write(rai, i * size, pages[i])
      await del(rai, sample(0, rai.length - 1), 0)
      for (let j in pages) {
        const buf = await read(rai, j * size, size)
        t.ok(!b4a.compare(buf, pages[j]))
      }
    })
    
    t.test('it should punch a hole in a single page', async function (t) {
      t.plan(3)
      const pages = [randombytes(size), randombytes(size), randombytes(size)]
      let i = 0
      const rai = storage()
      for (let i in pages) await write(rai, i * size, pages[i])

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

    t.test('it should punch a hole in multiple pages', function (t) {
      t.plan(9)
      const pages = [randombytes(size), randombytes(size), randombytes(size)]
      let i = 0
      const rai = storage()

      rai.write(i * size, pages[i], function onwrite (err) {
        t.absent(err)
        if (++i < pages.length) return rai.write(i * size, pages[i], onwrite)

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

        rai.read(ofst, s, onfstread)
          
        function onfstread (err, buf) {
          t.absent(err)
          t.ok(!b4a.compare(data, buf))

          rai.del(ofst, s, ondel)
          
          function ondel (err) {
            t.absent(err)
            rai.read(ofst, s, onsndread)
          }

          function onsndread (err, buf) {
            t.absent(err)
            const zeros = b4a.fill(b4a.alloc(s), 0)
            t.ok(b4a.compare(data, buf))
            t.ok(!b4a.compare(zeros, buf))
          }
        }
      })
    })

    t.test('it should delete to end of storage', function (t) {
      t.plan(8)
      const pages = [randombytes(size), randombytes(size), randombytes(size)]
      let i = 0
      const rai = storage()

      rai.write(i * size, pages[i], function onwrite (err) {
        t.absent(err)
        if (++i < pages.length) return rai.write(i * size, pages[i], onwrite)

        const l = rai.length // total number of bytes in store
        const o = sample(0, l - 1) // absolute offset into storage
        const s = l - o // number of bytes from offset to end of storage
        const pidx = Math.floor(o / size) // index of page containing absolute offset
        const idx = o - (pidx * size) // page-relative index that maps to absolute offset

        const data = b4a.alloc(s)
        let start = 0
        for (let p = pidx; p <= pages.length - 1; p++) {
          if (p === pidx) {
            b4a.copy(pages[p], data, start, idx, size)
            start = size - idx
          } else {
            b4a.copy(pages[p], data, start, 0, size)
            start += size
          }
        }

        rai.read(o, s, onfstread)
          
        function onfstread (err, buf) {
          t.absent(err)
          t.ok(!b4a.compare(data, buf))

          rai.del(o, s, ondel)
          
          function ondel (err) {
            t.absent(err)
            rai.read(o, s, onsndread)
          }

          function onsndread (err) {
            t.ok(err)
            t.is(rai.length, o)
          }
        }
      })
    })

    t.test('it should be equivalent to delete to end of storage or truncate', async function (t) {
      t.plan(6)
  
      const pages = [randombytes(size), randombytes(size), randombytes(size)]
      const rais = [storage(), storage()]
  
      for (let i in pages) {
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
})