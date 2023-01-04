const RandomAccessStorage = require('random-access-storage')
const isOptions = require('is-options')
const b4a = require('b4a')
const cenc = require('compact-encoding')

const DEFAULT_PAGE_SIZE = 4 * 1024 // 4096
const LOGICAL_BLOCK_SIZE = 1024 / 2 // 512
const DEFAULT_PREFIX = 'random-access-idb'

module.exports = class RandomAccessIDB extends RandomAccessStorage {
  size = DEFAULT_PAGE_SIZE
  indexedDB = window.indexedDB
  version = 1
  prefix = DEFAULT_PREFIX
  name = null
  id = null
  db = null
  length = 0

  static from (prefix, opts = {}) {
    return function (name, _opts = {}) {
      if (isOptions(name)) {
        _opts = name
        name = _opts.name
      }
      return new RandomAccessIDB(name, Object.assign({}, opts, _opts, { prefix }))
    }
  }

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
    if (opts.indexedDB) this.indexedDB = window.indexedDB

    if (!name) throw new Error('Must provide name for random-access-idb instance!')
    this.name = name
    this.id = this.prefix + '/' + this.name
  }

  _open (req) {
    const cb = req.callback.bind(req)
    const open = this.indexedDB.open(this.id, this.version)

    open.onerror = onerror
    open.onsuccess = onopen.bind(this)
    open.onupgradeneeded = onupgradeneeded.bind(this)

    function onerror () {
      cb(open.error || new Error('error opening indexedDB'))
    }

    function onopen () {
      this.db = open.result
      this._get('length', 'meta', onlen.bind(this))

      function onlen (err, len = 0) {
        if (err) return cb(err)
        this.length = len
        return cb(null)
      }
    }

    function onupgradeneeded (event) {
      const db = event.target.result
      if (!db.objectStoreNames.contains(this.name)) db.createObjectStore(this.name)
      if (!db.objectStoreNames.contains(`${this.name}/meta`)) db.createObjectStore(`${this.name}/meta`)
    }
  }

  _close (req) {
    const cb = req.callback.bind(req)
    this.db.close()
    return cb(null)
  }

  _stat (req) {
    const cb = req.callback.bind(req)

    const st = {
      size: this.length,
      blksize: this.size,
      blocks: 0
    }

    const [store] = this._store('readonly')
    const keys = store.getAllKeys()
    keys.onerror = () => cb(keys.error)
    keys.onsuccess = () => {
      st.blocks = Math.ceil((keys.result.length * this.size) / LOGICAL_BLOCK_SIZE)
      return cb(null, st)
    }
  }

  _read (req) {
    const cb = req.callback.bind(req)
    let idx = Math.floor(req.offset / this.size) // index of page
    let rel = req.offset - idx * this.size // page-relative start
    let start = 0

    if (req.offset + req.size > this.length) return cb(new Error('Could not satisfy length'))

    const data = b4a.alloc(req.size)

    return this._page(cenc.encode(cenc.lexint, idx), false, onpage.bind(this))

    function onpage (err, page) {
      if (err) cb(err)
      const avail = this.size - rel
      const wanted = req.size - start
      const len = (avail < wanted) ? avail : wanted
      const end = rel + len
      if (page) b4a.copy(page, data, start, rel, end)
      start += len
      rel = 0
      return (start < req.size)
        ? this._page(cenc.encode(cenc.lexint, ++idx), false, onpage.bind(this))
        : cb(null, data)
    }
  }

  _write (req) {
    const cb = req.callback.bind(req)
    let idx = Math.floor(req.offset / this.size)
    let rel = req.offset - idx * this.size
    let start = 0

    const len = req.offset + req.size
    const ops = []

    return this._page(cenc.encode(cenc.lexint, idx), true, onpage.bind(this))

    function onpage (err, page) {
      if (err) return cb(err)
      const free = this.size - rel
      const end = (free < (req.size - start)) ? start + free : req.size
      b4a.copy(req.data, page, rel, start, end)
      start = end
      rel = 0
      ops.push({ type: 'put', key: cenc.encode(cenc.lexint, idx), value: page })
      if (start < req.size) {
        this._page(cenc.encode(cenc.lexint, ++idx), true, onpage.bind(this))
      } else {
        if (len > this.length) ops.push({ type: 'put', key: 'length', value: len, db: 'meta' })
        this._batch(ops, onbatch.bind(this))
      }
    }

    function onbatch (err) {
      if (err) return cb(err)
      if (len > this.length) this.length = len
      return cb(null, null)
    }
  }

  _del (req) {
    const cb = req.callback.bind(req)
    if (req.offset >= this.length) return cb(new Error('Could not delete: offset does not exist'))
    if (req.size === Infinity) req.size = Math.max(0, this.length - req.offset)

    const fstpage = Math.floor(req.offset / this.size)
    const fstidx = req.offset - (fstpage * this.size)

    const lstpage = Math.floor((req.offset + req.size) / this.size)
    const lstidx = (req.offset + req.size) - (lstpage * this.size)

    const truncating = (req.offset + req.size) >= this.length
    const interpage = (fstpage === lstpage)

    const ops = []

    this._get(cenc.encode(cenc.lexint, fstpage), onfstpage.bind(this))

    function onfstpage (err, page) {
      if (err) return cb(err)

      if (fstidx || interpage) { // trimming from tail of page OR punching a hole in a single page
        const end = (interpage) ? lstidx : this.size
        b4a.fill(page, 0, fstidx, end)
        ops.push({ type: 'put', key: cenc.encode(cenc.lexint, fstpage), value: page })
      }

      if (interpage) return batch.apply(this)

      const start = (fstidx) ? fstpage + 1 : fstpage
      const end = (truncating) ? lstpage : lstpage - 1

      for (let i = start; i <= end; i++) {
        ops.push({ type: 'del', key: cenc.encode(cenc.lexint, i) })
      }

      if (truncating) return batch.apply(this)

      this._get(cenc.encode(cenc.lexint, lstpage), onlstpage.bind(this))
    }

    function onlstpage (err, page) {
      if (err) return cb(err)
      b4a.fill(page, 0, 0, lstidx)
      ops.push({ type: 'put', key: cenc.encode(cenc.lexint, lstpage), value: page })
      if (req.offset + req.size >= this.length) {
        ops.push({ type: 'put', key: 'length', value: req.offset, db: 'meta' })
      }
      return batch.apply(this)
    }

    function batch () {
      this._batch(ops, (err) => {
        if (err) return cb(err)
        if (req.offset + req.size >= this.length) this.length = req.offset
        return cb(null)
      })
    }
  }

  _unlink (req) {
    const cb = req.callback.bind(req)
    this.close((err) => {
      if (err) return cb(err)
      const del = this.indexedDB.deleteDatabase(this.id)
      del.onerror = () => cb(del.error)
      del.onsuccess = () => cb(null)
    })
  }

  _page (key, upsert, cb) {
    this._get(key, (err, page) => {
      if (err) return cb(err)
      if (page || !upsert) return cb(null, page)
      page = b4a.alloc(this.size)
      return cb(null, page)
    })
  }

  _store (mode) {
    const txn = this.db.transaction([this.name, `${this.name}/meta`], mode)
    return [txn.objectStore(this.name), txn.objectStore(`${this.name}/meta`)]
  }

  _get (key, ...args) {
    const [db, cb] = (args.length === 1) ? ['store', args[0]] : args
    try {
      const [store, meta] = this._store('readonly')
      const req = (db === 'meta' ? meta : store).get(key)
      const txn = req.transaction
      txn.onabort = () => cb(txn.error || new Error('idb get aborted'))
      txn.oncomplete = () => cb(null, req.result)
    } catch (err) {
      return cb(err)
    }
  }

  _batch (ops = [], cb) {
    const [store, meta] = this._store('readwrite')
    const txn = store.transaction
    let idx = 0
    let error = null
    txn.onabort = () => cb(error || txn.error || new Error('idb batch op aborted'))
    txn.oncomplete = () => cb(null)

    function next () {
      const op = ops[idx++]
      const { type, key, value, db } = op
      const backend = (db === 'meta') ? meta : store
      try {
        const req = (type === 'del') ? backend.delete(key) : backend.put(value, key)
        if (idx < ops.length) req.onsuccess = next
        else if (txn.commit) txn.commit()
      } catch (err) {
        error = err
        txn.abort()
      }
    }

    next()
  }
}
