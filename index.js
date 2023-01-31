const RandomAccessStorage = require('random-access-storage')
const isOptions = require('is-options')
const b4a = require('b4a')
const cenc = require('compact-encoding')
const SubEnc = require('sub-encoder')
const once = require('once')

const DEFAULT_PAGE_SIZE = 4 * 1024 // 4096
const BLOCK_SIZE = 512
const DEFAULT_DBNAME = 'random-access-idb'

const DBS = new Map() // dbname: String -> { db: new IndexedDB(), refs: Int, teardown: [() => {}] }

const lexintEnc = {
  encode (obj) { return cenc.encode(cenc.lexint, obj) },
  decode (buf) { return cenc.decode(cenc.lexint, buf) }
}

module.exports = class RandomAccessIDB extends RandomAccessStorage {
  indexedDB = window.indexedDB
  _dbs = DBS
  db = null
  codec = null
  version = 1
  dbname = DEFAULT_DBNAME
  name = null
  size = DEFAULT_PAGE_SIZE
  length = 0
  codecs = {}

  static storage (dbname, opts = {}) {
    return function (name, _opts = {}) {
      if (isOptions(name)) {
        _opts = name
        name = _opts.name
      }
      return new RandomAccessIDB(name, Object.assign({}, opts, _opts, { dbname }))
    }
  }

  constructor (name, opts = {}) {
    super()

    if (isOptions(name)) {
      opts = name
      name = opts.name
    }

    if (opts.size) this.size = opts.size || this.size
    if (opts.dbname) this.dbname = opts.dbname || this.dbname
    if (opts.version) this.version = opts.version || this.version
    if (opts.indexedDB) this.indexedDB = opts.indexedDB
    if (opts.db) this.db = opts.db

    if (!name) throw new Error('Must provide name for random-access-idb instance!')
    this.name = name

    const root = new SubEnc(this.dbname, { keyEncoding: 'utf-8' })
    const ns = root.sub(this.name)
    const meta = ns.sub('meta')
    const page = ns.sub('page', { keyEncoding: lexintEnc })

    this.codecs = { root, ns, meta, page }
  }

  _store (mode) {
    const txn = this.db.transaction([this.dbname], mode)
    return txn.objectStore(this.dbname)
  }

  _get (store, key, codec, cb) {
    cb = once(cb)
    try {
      const req = store.get(codec.encode(key))
      req.onerror = (err) => cb(err || new Error('db.get aborted', key))
      req.onsuccess = () => cb(null, req.result)
    } catch (err) {
      return cb(err)
    }
  }

  _page (store, key, upsert, cb) {
    this._get(store, key, this.codecs.page, (err, page) => {
      if (err) return cb(err)
      if (page || !upsert) return cb(null, page)
      page = b4a.alloc(this.size)
      return cb(null, page)
    })
  }

  _open (req) {
    const cb = once(req.callback.bind(req))

    if (this._dbs.has(this.dbname)) {
      const memo = this._dbs.get(this.dbname)
      memo.refs++
      this.db = memo.db
      const store = this._store('readonly')
      return this._get(store, 'length', this.codecs.meta, onlen.bind(this))
    }

    const open = this.indexedDB.open(this.dbname, this.version)

    open.onerror = onerror
    open.onsuccess = onopen.bind(this)
    open.onupgradeneeded = onupgradeneeded.bind(this)

    function onerror () { cb(open.error || new Error('error opening indexedDB')) }

    function onopen () {
      this.db = open.result
      this._dbs.set(this.dbname, { db: this.db, refs: 1 })
      const store = this._store('readonly')
      this._get(store, 'length', this.codecs.meta, onlen.bind(this))
    }

    function onupgradeneeded (event) {
      const db = event.target.result
      if (!db.objectStoreNames.contains(this.dbname)) db.createObjectStore(this.dbname)
    }

    function onlen (err, len = 0) {
      if (err) return cb(err)
      this.length = len
      return cb(null)
    }
  }

  _close (req) {
    const cb = req.callback.bind(req)
    const memo = this._dbs.get(this.dbname)

    if (--memo.refs) return cb(null) // someone in the process still working

    // close db and cleanup
    this.db.close()
    this._dbs.delete(this.dbname)
    memo.db = null

    return cb(null)
  }

  _stat (req) {
    const cb = req.callback.bind(req)
    const store = this._store('readonly')

    const st = {
      size: this.length,
      blksize: this.size,
      blocks: 0
    }

    if (!this.length) return cb(null, st)

    let idx = 0
    const maxidx = Math.floor((this.length - 1) / this.size)

    this._page(store, idx, false, onpage.bind(this))

    function onpage (err, page) {
      if (err) return cb(err)
      st.blocks += (page.byteLength) ? Math.ceil(1, Math.floor(page.byteLength / BLOCK_SIZE)) : 0
      idx += 1
      if (idx < maxidx) return this._page(store, idx, false, onpage.bind(this))
      else return cb(null, st)
    }
  }

  _read (req) {
    const cb = req.callback.bind(req)
    const store = this._store('readonly')

    let idx = Math.floor(req.offset / this.size) // index of page
    let rel = req.offset - idx * this.size // page-relative start
    let start = 0

    if (req.offset + req.size > this.length) return cb(new Error('Could not satisfy length'))

    const data = b4a.alloc(req.size)

    return this._page(store, idx, false, onpage.bind(this))

    function onpage (err, page) {
      if (err) cb(err)
      const available = this.size - rel // how many bytes remain in this page from relative offset
      const wanted = req.size - start // total remaining bytes we want to read
      // size of next read is floor of remaining bytes in page or total remaining bytes to read
      const len = Math.floor(available, wanted)
      const end = rel + len // end offset of next read within this page
      if (page) b4a.copy(page, data, start, rel, end)
      start += len // we've read <len> more bytes, so adjust "start"
      rel = 0 // if there's more to read, it starts at the beginning of the next page
      if (start < req.size) return this._page(store, ++idx, false, onpage.bind(this)) // if more, read
      return cb(null, data) // if not, finish
    }
  }

  _write (req) {
    const cb = req.callback.bind(req)
    const store = this._store('readwrite')
    const { codecs } = this

    let idx = Math.floor(req.offset / this.size)
    let rel = req.offset - idx * this.size
    let start = 0 // offset in data to write we are copying from

    const len = req.offset + req.size
    const ops = []

    return this._page(store, idx, true, onpage.bind(this))

    function onpage (err, page) {
      if (err) return cb(err)
      // num bytes we can write in this page
      const free = this.size - rel
      // end offset in data to write we are copying from
      //  if: num bytes we can write is less than remaining bytes to write
      //  then: copy num bytes we can write
      //  else: copy remaining bytes
      const end = (free < (req.size - start)) ? start + free : req.size
      b4a.copy(req.data, page, rel, start, end)
      start = end // update offset we begin writing from
      rel = 0 // update rel offset in page we will write to
      ops.push({ type: 'put', key: codecs.page.encode(idx), value: page }) // batch write
      if (start < req.size) return this._page(store, ++idx, true, onpage.bind(this))
      if (len > this.length) ops.push({ type: 'put', key: codecs.meta.encode('length'), value: len })
      return this._batch(store, ops, onbatch.bind(this))
    }

    function onbatch (err) {
      if (err) return cb(err)
      if (len > this.length) this.length = len
      return cb(null)
    }
  }

  _del (req) {
    const cb = req.callback.bind(req)
    const store = this._store('readwrite')
    // deleting bytes beyond length, they're already gone!
    if (req.offset >= this.length) return cb(null)
    // deleting no bytes, they're already gone!
    if (req.size === 0) return cb(null)
    if (req.size === Infinity) req.size = Math.max(0, this.length - req.offset)

    const { codecs } = this
    const ops = []
    const lst = req.offset + req.size

    let idx = Math.floor(req.offset / this.size)
    let rel = req.offset - idx * this.size
    let start = 0

    this._page(store, idx, false, onpage.bind(this))

    function onpage (err, page) {
      if (err) return cb(err)
      const available = this.size - rel // bytes in page we can delete
      const wanted = req.size - start // total bytes left to delete
      const len = Math.floor(available, wanted) // num bytes to remove in this del
      const end = rel + len // offset of last byte to remove in this page
      if (rel === 0 && len === this.size) { // del entire page
        ops.push({ type: 'del', key: codecs.page.encode(idx) })
      } else { // del within page
        b4a.fill(page, 0, rel, end)
        ops.push({ type: 'put', key: codecs.page.encode(idx), value: page })
      }
      start += len
      rel = 0
      if (start < req.size) return this._page(store, ++idx, false, onpage.bind(this)) // if more, del
      if (lst >= this.length) {
        ops.push({ type: 'put', key: codecs.meta.encode('length'), value: req.offset })
      }
      return this._batch(store, ops, onbatch.bind(this)) // if not, finish
    }

    function onbatch (err) {
      if (err) return cb(err)
      if (lst >= this.length) this.length = req.offset
      return cb(null)
    }
  }

  _unlink (req) {
    const cb = once(req.callback.bind(req))
    const memo = this._dbs.get(this.dbname)

    if (memo && memo.refs) {
      return cb(new Error(
        `Close all RandomAccessIDB instances with dbname=${this.dbname} before unlinking!`
      ))
    }

    const del = this.indexedDB.deleteDatabase(this.dbname)
    del.onerror = () => cb(del.error)
    del.onsuccess = () => cb(null)
  }

  _batch (store, ops = [], cb) {
    cb = once(cb)
    const txn = store.transaction
    let error = null
    txn.onerror = (e) => cb(e)
    txn.onabort = () => cb(error || txn.error || new Error('idb batch op aborted'))
    txn.oncomplete = () => cb(null)

    const next = (idx) => {
      const op = ops[idx]
      const { type, key, value } = op
      try {
        (type === 'del') ? store.delete(key) : store.put(value, key)
        if (idx + 1 < ops.length) return next(idx + 1)
        if (txn.commit) txn.commit()
      } catch (err) {
        error = err
        txn.abort()
      }
    }

    return next(0)
  }
}
