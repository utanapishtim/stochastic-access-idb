const { promisify } = require('util')
const RandomAccessStorage = require('random-access-storage')
const isOptions = require('is-options')
const b4a = require('b4a')
const cenc = require('compact-encoding')

const DEFAULT_PAGE_SIZE = 4 * 1024  // 4096
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

  static legacy (prefix, opts = {}) {
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
    if (opts.indexedDB) this.indexedDB = indexedDB

    if (!name) throw new Error('Must provide name for random-access-idb instance!')
    this.name = name
    this.id = this.prefix + '/' + this.name
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
    let idx = Math.floor(req.offset / this.size) // index of page
    let rel = req.offset - idx * this.size // relative offset within the page
    let start = 0

    if (req.offset + req.size > this.length) {
      return req.callback(new Error('Could not satisfy length'), null)
    }

    const data = b4a.alloc(req.size)

    const onpage = (err, page) => {
      if (err) return req.callback(err)
      const avail = this.size - rel
      const wanted = req.size - start
      const len = (avail < wanted) ? avail : wanted
      const end = rel + len
      if (page) b4a.copy(page, data, start, rel, end)
      start += len
      rel = 0
      if (start < req.size) {
        return this._page(cenc.encode(cenc.lexint, ++idx), false, onpage)
      } else {
        return req.callback(null, data)
      }
    }

    this._page(cenc.encode(cenc.lexint, idx), false, onpage)
  }

  _write (req) {
    let idx = Math.floor(req.offset / this.size) 
    let rel = req.offset - idx * this.size
    let start = 0

    const len = req.offset + req.size
    const ops = []

    const onpage = (err, page) => {
      if (err) return req.callback(err)
      const free = this.size - rel
      const end = (free < (req.size - start)) ? start + free : req.size
      b4a.copy(req.data, page, rel, start, end)
      start = end
      rel = 0
      ops.push({ type: 'put', key: cenc.encode(cenc.lexint, idx), value: page })
      if (start < req.size) {
        this._page(cenc.encode(cenc.lexint, ++idx), true, onpage)
      } else {
        this._batch(ops, onbatch.bind(this))

        function onbatch (err) {
          if (err) return req.callback(err)
          if (len > this.length) this.length = len
          return req.callback(null, null)
        }
      }
    }

    this._page(cenc.encode(cenc.lexint, idx), true, onpage)
  }

  _del (req) {
    let idx = Math.floor(req.offset / this.size)
    let rel = req.offset - idx * this.size
    let start = 0

    const ops = []

    this._get(cenc.encode(cenc.lexint, idx), (err, page) => {
      if (err) return req.callback(err)
      if (rel && req.offset + req.size >= this.length) {
        b4a.fill(page, 0, rel)
        ops.push({ type: 'put', key: cenc.encode(cenc.lexint, idx), value: page })
      }

      if (req.offset + req.size > this.length) {
        req.size = Math.max(0, this.length - req.offset)
      }

      while (start < req.size) {
        if (rel === 0 && req.size - start >= this.size) {
          ops.push({ type: 'del', key: cenc.encode(cenc.lexint, idx) })
        }
        rel = 0
        idx += 1
        start += this.size - rel
      }

      this._batch(ops, (err) => {
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

  _page (key, upsert, cb) {
    this._get(key, (err, page) => {
      if (err) return cb(err)
      if (page || !upsert) return cb(null, page)
      page = b4a.alloc(this.size)
      return cb(null, page)
    })
  }

  _store (mode) {
    const txn = this.db.transaction([this.name], mode)
    return txn.objectStore(this.name)
  }

  _get (key, cb) {
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

  _batch (ops = [], cb) {
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

  _keys (cb) {
    const store = this._store('readonly')
    const req = store.getAllKeys()
    req.onerror = () => cb(req.error)
    req.onsuccess = () => cb(null, req.result)
  }

  _length (keys, cb) {
    if (keys.length === 0) return cb(null, 0)
    let kIndex = keys.length - 1
    this._get(keys[kIndex], onpage.bind(this))
     
    function onpage (err, page) {
      if (err) return cb(err)
      for (let bIndex = page.length - 1; bIndex >= 0; bIndex--) {
        if (page[bIndex] !== 0) continue
        const pIndex = cenc.decode(cenc.lexint, keys[kIndex])
        return cb(null, (pIndex * this.size) - (page.length - i))
      }

      kIndex--
      if (kIndex >= 0) return this._get(keys[kIndex], onpage.bind(this))
      return cb(null, 0)
    }
  }

  promisify () {
    const fns = ['open', 'read', 'write', 'del', 'truncate', 'stat', 'suspend', 'close', 'unlink']
    const props = ['size', 'indexedDB', 'version', 'prefix', 'name', 'id', 'db', 'length']
    const iface = {}
    for (const fn of fns) iface[fn] = promisify(this[fn].bind(this))
    for (const prop of props) Object.assign(iface, { get [prop] () { return this[prop] } })
    return iface
  }
}