const RandomAccessStorage = require('random-access-storage')
const isOptions = require('is-options')
const b4a = require('b4a')
const cenc = require('compact-encoding')
const SubEnc = require('sub-encoder')
const once = require('once')

const DEFAULT_PAGE_SIZE = 4 * 1024 // 4096
const BLOCK_SIZE = 512
const DEFAULT_DBNAME = 'random-access-idb'

// dbname: String -> { db: IndexedDB, refs: Number }
const DBS = new Map()

const lexintEnc = {
  encode (obj) { return cenc.encode(cenc.lexint, obj) },
  decode (buf) { return cenc.decode(cenc.lexint, buf) }
}

module.exports = class RandomAccessIDB extends RandomAccessStorage {
  _indexedDB = window.indexedDB
  _dbs = DBS

  db = null
  dbname = DEFAULT_DBNAME
  version = 1
  name = null
  size = DEFAULT_PAGE_SIZE
  length = 0
  codecs = {}

  static storage (dbname = DEFAULT_DBNAME, opts = {}) {
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

    if (!name) throw new Error('Must provide name for RandomAccessIDB instance!')
    this.name = name

    const root = new SubEnc(this.dbname, { keyEncoding: 'utf-8' })
    const ns = root.sub(this.name)
    const meta = ns.sub('meta')
    const page = ns.sub('page', { keyEncoding: lexintEnc })

    this.codecs = { root, ns, meta, page }
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

    const open = this._indexedDB.open(this.dbname, this.version)

    open.onerror = cb
    open.onsuccess = onopen.bind(this)
    open.onupgradeneeded = onupgradeneeded.bind(this)

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

    const maxidx = Math.floor((this.length - 1) / this.size)
    let idx = 0

    this._page(store, idx, false, onpage.bind(this))

    function onpage (err, page) {
      if (err) return cb(err)
      st.blocks += (page && page.byteLength) ? Math.ceil(1, Math.floor(page.byteLength / BLOCK_SIZE)) : 0
      if (++idx < maxidx) return this._page(store, idx, false, onpage.bind(this))
      else return cb(null, st)
    }
  }

  _read (req) {
    const cb = req.callback.bind(req)
    const store = this._store('readonly')

    if (req.offset + req.size > this.length) return cb(new Error('Could not satisfy length'))

    let idx = Math.floor(req.offset / this.size) // index of page
    let rel = req.offset - idx * this.size // page-relative start
    let start = 0

    const data = b4a.alloc(req.size)

    return this._page(store, idx, false, onpage.bind(this))

    function onpage (err, page) {
      if (err) cb(err)

      const available = this.size - rel
      const wanted = req.size - start
      const len = Math.min(available, wanted)
      const end = rel + len

      if (page) b4a.copy(page, data, start, rel, end)

      start += len
      rel = 0

      if (start < req.size) return this._page(store, ++idx, false, onpage.bind(this))
      return cb(null, data)
    }
  }

  _write (req) {
    const cb = req.callback.bind(req)
    const store = this._store('readwrite')
    const { codecs } = this

    let idx = Math.floor(req.offset / this.size)
    let rel = req.offset - idx * this.size
    let start = 0

    const length = Math.max(this.length, req.offset + req.size)
    const ops = []

    return this._page(store, idx, true, onpage.bind(this))

    function onpage (err, page) {
      if (err) return cb(err)

      const free = this.size - rel
      const end = (free < (req.size - start)) ? start + free : req.size

      b4a.copy(req.data, page, rel, start, end)
      ops.push({ type: 'put', key: codecs.page.encode(idx), value: page })

      start = end
      rel = 0

      if (start < req.size) return this._page(store, ++idx, true, onpage.bind(this))
      ops.push({ type: 'put', key: codecs.meta.encode('length'), value: length })
      return this._batch(store, ops, onbatch.bind(this))
    }

    function onbatch (err) {
      if (err) return cb(err)
      this.length = length
      return cb(null)
    }
  }

  _del (req) {
    const cb = req.callback.bind(req)
    const store = this._store('readwrite')

    if (req.offset >= this.length || req.size === 0) return cb(null)
    if (req.size === Infinity) req.size = Math.max(0, this.length - req.offset)

    const { codecs } = this
    const ops = []
    const length = ((req.offset + req.size) >= this.length) ? req.offset : this.length

    let idx = Math.floor(req.offset / this.size)
    let rel = req.offset - idx * this.size
    let start = 0

    this._page(store, idx, false, onpage.bind(this))

    function onpage (err, page) {
      if (err) return cb(err)

      const available = this.size - rel
      const wanted = req.size - start
      const len = Math.min(available, wanted)
      const end = rel + len

      if (rel === 0 && len === this.size) {
        ops.push({ type: 'del', key: codecs.page.encode(idx) })
      } else {
        b4a.fill(page, 0, rel, end)
        ops.push({ type: 'put', key: codecs.page.encode(idx), value: page })
      }

      start += len
      rel = 0

      if (start < req.size) return this._page(store, ++idx, false, onpage.bind(this))
      ops.push({ type: 'put', key: codecs.meta.encode('length'), value: length })
      return this._batch(store, ops, onbatch.bind(this))
    }

    function onbatch (err) {
      if (err) return cb(err)
      this.length = length
      return cb(null)
    }
  }

  _store (mode) {
    const txn = this.db.transaction([this.dbname], mode)
    return txn.objectStore(this.dbname)
  }

  _get (store, key, codec, cb) {
    cb = once(cb)
    try {
      const req = store.get(codec.encode(key))
      req.onerror = (err) => cb(err)
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

  _batch (store, ops = [], cb) {
    cb = once(cb)

    const txn = store.transaction
    txn.onabort = () => cb(txn.error)
    txn.oncomplete = () => cb(null)

    for (const { type, key, value } of ops) {
      try {
        (type === 'del') ? store.delete(key) : store.put(value, key)
      } catch (err) {
        txn.error = err
        txn.abort()
      }
    }

    if (txn.commit) txn.commit()
  }
}
