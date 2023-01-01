const RandomAccessStorage = require('random-access-storage')
const isOptions = require('is-options')
const b4a = require('b4a')
const cenc = require('compact-encoding')

const DEFAULT_PAGE_SIZE = 1024 * 4
const LOGICAL_BLOCK_SIZE = 512
const DEFAULT_PREFIX = 'random-access-storage/random-access-idb'

module.exports = class RandomAccessIDB extends RandomAccessStorage {
  size = DEFAULT_PAGE_SIZE
  length = 0
  prefix = DEFAULT_PREFIX
  name = null
  id = null
  version = 1
  db = null
  indexedDB = window.indexedDB

  constructor (name, opts = {}) {
    super()

    if (isOptions(name)) {
      opts = name
      name = opts.name
    }

    if (opts.size) this.size = opts.size
    if (opts.prefix) this.prefix = opts.prefix
    if (opts.version) this.version = opts.version || this.version
    if (opts.db) this.db = opts.db
    if (opts.indexedDB) this.indexedDB = indexedDB

    if (!name) throw new Error('Must provide name for random-access-idb instance!')
    this.name = name
    this.id = this.prefix + '/' + this.name
  }

  _store (mode) {
    const txn = this.db.transaction([this.name], mode)
    return txn.objectStore(this.name)
  }

  _open (req) {
    const open = this.indexedDB.open(this.id, this.version)

    open.onerror = onerror
    open.onsuccess = onopen.bind(this)
    open.onupgradeneeded = onupgradeneeded.bind(this)

    function onerror () {
      req.callback(open.error || new Error('error opening indexedDB'))
    }

    function onopen () {
      this.db = open.result
      this._keys((err, keys) => {
        if (err) return req.callback(err)
        this._length(keys, (err, len) => {
          if (err) return req.callback(err)
          this.length = len
          return req.callback(null)
        })
      })
    }

    function onupgradeneeded (event) {
      const db = event.target.result
      if (!db.objectStoreNames.contains(this.name)) db.createObjectStore(this.name)
    }
  }

  _close (req) {
    this.db.close()
    return req.callback(null, null)
  }

  _stat (req) {
    const st = {
      size: this.length,
      blksize: this.size,
      blocks: 0
    }

    this._keys((err, keys) => {
      if (err) return req.callback(err)
      st.blocks = Math.ceil((keys.length * this.size) / LOGICAL_BLOCK_SIZE)
      return req.callback(null, st)
    })
  }

  _read (req) {
    console.log('(read)')
    console.log('(read.req.offset)', req.offset)
    console.log('(read.req.size)', req.size)

    let idx = Math.floor(req.offset / this.size) // index of page
    console.log('(read.idx)', idx)

    let rel = req.offset - idx * this.size // relative offset within the page
    console.log('(read.rel)', rel)

    let start = 0
    console.log('(read.start)', start)

    console.log('(read!(req.offset + req.size > this.length))', req.offset + req.size, this.length, req.offset + req.size > this.length)
    if (req.offset + req.size > this.length) {
      return req.callback(new Error('Could not satisfy length'), null)
    }

    const data = b4a.alloc(req.size)

    const onpage = (err, page) => {
      if (err) return req.callback(err)
      console.log('(read/onpage)')
      console.log('(read/onpage.idx)', idx)
      console.log('(read/onpage.rel)', rel)
      console.log('(read/onpage.start)', start)
      const avail = this.size - rel
      console.log('(read/onpage.avail)', avail)
      const wanted = req.size - start
      console.log('(read/onpage.wanted)', wanted)
      const len = (avail < wanted) ? avail : wanted
      console.log('(read/onpage.len)', len)
      const end = rel + len
      console.log('(read/onpage.end)', end)
      console.log('(read/onpage.page)', page)
      if (page) b4a.copy(page, data, start, rel, rel + len)
      start += len
      rel = 0
      idx++
      if (start < req.size) {
        return this._page(cenc.encode(cenc.lexint, idx), false, onpage)
      } else {
        return req.callback(null, data)
      }
    }

    this._page(cenc.encode(cenc.lexint, idx), false, onpage)
  }

  _write (req) {
    console.log('(write)')
    console.log('(write.req.offset)', req.offset)
    console.log('(write.req.size)', req.size)
    console.log('(write.req.data)', req.data)
    console.log('(write?this.size)', this.size)
    let idx = Math.floor(req.offset / this.size) 
    let rel = req.offset - idx * this.size
    let start = 0
    console.log('(write/onpage.idx)', idx)
    console.log('(write/onpage.rel)', rel)
    console.log('(write/onpage.start)', start)
    const len = req.offset + req.size
    console.log('(write/onpage.len)', len)
    const ops = []


    const onpage = (err, page) => {
      if (err) return req.callback(err)
      console.log('(write/onpage)')
      console.log('(write/onpage.idx)', idx)
      console.log('(write/onpage.rel)', rel)
      console.log('(write/onpage.start)', start)
      const free = this.size - rel // how much space is left in the page from the page-relative offset
      console.log('(write/onpage.free)', free)
      const end = (free < (req.size - start)) ? start + free : req.size // if the amount of space left in the page is less than the data to write
      console.log('(write/onpage.end)', end)
      b4a.copy(req.data, page, rel, start, end)
      console.log('(write/onpage.page)', page)
      start = end
      rel = 0
      ops.push({ type: 'put', key: cenc.encode(cenc.lexint, idx), value: page })
      console.log('(write/onpage!(start < req.size))', start, req.size, start < req.size)
      if (start < req.size) {
        idx++
        this._page(cenc.encode(cenc.lexint, idx), true, onpage)
      } else {
        console.log('(write/onpage#write batch)', ops)
        this._idbBatch(ops, (err) => {
          if (err) return req.callback(err)
          if (len > this.length) this.length = len
          return req.callback(null, null)
        })
      }
    }

    this._page(cenc.encode(cenc.lexint, idx), true, onpage)
  }

  _del (req) {
    let idx = Math.floor(req.offset / this.size)
    let rel = req.offset - idx * this.size
    let start = 0

    const ops = []

    this._idbGet(idx, (err, page) => {
      if (err) return req.callback(err)
      if (rel && req.offset + req.size >= this.length) {
        b4a.fill(page, 0, rel)
        ops.push({ type: 'put', key: cenc.encode(cenc.lexint, idx), value: page })
      }

      if (req.offset + req.size > this.length) {
        req.size = Math.max(0, this.length - req.offset)
      }

      while (start < req.size) {
        if (rel === 0 && req.size - start >= this.pageSize) ops.push({ type: 'del', key: idx })
        rel = 0
        idx += 1
        start += this.size - rel
      }

      this._idbBatch(ops, (err) => {
        if (err) return req.callback(err)
        if (req.offset + req.size >= this.length) this.length = req.offset
        return req.callback(null)
      })
    })
  }

  _unlink (req) {
    const store = this._store('readwrite')
    const clear = store.clear()
    clear.onerror = () => req.callback(clear.error)
    clear.onsuccess = () => {
      const del = this.indexedDB.deleteDatabase(this.id)
      del.onerror = () => req.callback(del.error)
      del.onsuccess = () => req.callback(null) 
    }
  }

  _idbGet (key, cb) {
    try {
      const store = this._store('readonly')
      const req = store.get(key)
      const txn = req.transaction
      txn.onabort = () => cb(txn.error || new Error('idb get aborted'))
      txn.oncomplete = () => cb(null, req.result)
    } catch (err) {
      return cb(err)
    }
  }

  _idbPut (key, val, cb) {
    try {
      const store = this._store('readwrite')
      const req = store.put(val, key)
      const txn = req.transaction
      txn.onabort = () => cb(txn.error || new Error('idb put aborted'))
      txn.oncomplete = () => cb(null, req.result)
    } catch (err) {
      return cb(err)
    }
  }

  _idbDel (key, cb) {
    try {
      const store = this._store('readwrite')
      const req = store.delete(key)
      const txn = req.transaction
      txn.onabort = () => cb(txn.error || new Error('idb del aborted'))
      txn.oncomplete = () => cb(null, req.result)
    } catch (err) {
      return cb(err)
    }
  }

  _idbBatch (ops = [], cb) {
    const store = this._store('readwrite')
    const txn = store.transaction
    let idx = 0
    let error = null
    txn.onabort = () => cb(error || txn.error || new Error('idb batch op aborted'))
    txn.oncomplete = () => cb(null)

    function next () {
      const op = ops[idx++]
      const { type, key, value } = op
      try {
        const req = (type === 'del') ? store.delete(key) : store.put(value, key)
        req.onerror = (err) => console.error(`batch error: ${err}`)
        if (idx < ops.length) req.onsuccess = next
        else if (typeof txn.commit === 'function') txn.commit()
      } catch (err) {
        error = err
        txn.abort()
        return
      }
    }

    next()
  }

  _length (keys, cb) {
    if (keys.length === 0) return cb(null, 0)
    let kIndex = keys.length - 1
    this._idbGet(keys[kIndex], onpage.bind(this))
     
    function onpage (err, page) {
      if (err) return cb(err)
      for (let bIndex = page.length - 1; bIndex >= 0; bIndex--) {
        if (page[bIndex] !== 0) continue
        const pIndex = cenc.decode(cenc.lexint, keys[kIndex])
        return cb(null, (pIndex * this.size) - (page.length - i))
      }

      kIndex--
      if (kIndex >= 0) return this._idbGet(keys[kIndex], onpage.bind(this))
      return cb(null, 0)
    }
  }

  _keys (cb) {
    const store = this._store('readonly')
    const req = store.getAllKeys()
    req.onerror = () => cb(req.error)
    req.onsuccess = () => cb(null, req.result)
  }

  _page (key, upsert, cb) {
    this._idbGet(key, (err, page) => {
      if (err) return cb(err)
      if (page || !upsert) return cb(null, page)
      page = b4a.alloc(this.size)
      return cb(null, page)
    })
  }
}