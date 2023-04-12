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
    const page = ns.sub('page', {
      keyEncoding: {
        encode (obj) { return cenc.encode(cenc.lexint, obj) },
        decode (buf) { return cenc.decode(cenc.lexint, buf) }
      }
    })

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

    open.onerror = onerror
    open.onsuccess = onopen.bind(this)
    open.onupgradeneeded = onupgradeneeded.bind(this)

    function onerror (e) { return cb(e || open.error) }

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

  _blocks (start, end) {
    const { size } = this
    const blocks = []
    for (let n = Math.floor(start / size) * size; n < end; n += size) {
      blocks.push({
        page: Math.floor(n / size),
        start: Math.max(n, start) % size,
        end: Math.min(n + size, end) % size || size
      })
    }
    return blocks
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

    if ((req.offset + req.size) > this.length) return cb(new Error('Could not satisfy length'))

    const blocks = this._blocks(req.offset, req.offset + req.size)
    const buffers = new Array(blocks.length)
    const fstBlock = blocks.length > 0 ? blocks[0].page : 0
    let pending = blocks.length + 1

    const onblock = _onblock.bind(this)
    for (let i = 0; i < blocks.length; i++) onblock(blocks[i])

    return done()

    function _onblock (block) {
      const { page, start, end } = block
      const len = end - start
      this._page(store, page, false, (err, buf) => {
        if (err) return done(err)
        buffers[page - fstBlock] = (buf)
          ? (len === this.size)
              ? buf
              : b4a.from(buf.subarray(start, end))
          : b4a.alloc(len)
        return done()
      })
    }

    function done (err) {
      if (err) return cb(err)
      if (!--pending) return cb(null, b4a.concat(buffers))
    }
  }

  _write (req) {
    const cb = req.callback.bind(req)
    const { codecs } = this
    const length = Math.max(this.length, req.offset + req.size)
    const store = this._store('readwrite')
    const blocks = this._blocks(req.offset, req.offset + req.size)
    const buffers = {}
    const done = _done.bind(this)
    const onblock = _onblock.bind(this)

    let pending = 1

    for (const i in blocks) onblock(blocks[i], i)

    return done()

    function _onblock (block, i) {
      const { page, start, end } = block
      if (end - start === this.size) return
      pending++
      this._page(store, page, true, (err, buf) => {
        if (err) return done(err)
        buffers[i] = buf
        return done()
      })
    }

    function _done (err) {
      if (err) return cb(err)
      if (--pending > 0) return
      let j = 0

      for (const i in blocks) {
        const { page, start, end } = blocks[i]
        const len = end - start
        const key = codecs.page.encode(page)
        if (len === this.size) {
          store.put(req.data.slice(j, j += len), key)
        } else {
          b4a.copy(req.data, buffers[i], start, j, j += len)
          store.put(buffers[i], key)
        }
      }

      store.put(length, codecs.meta.encode('length'))

      const txn = store.transaction
      txn.onabort = () => cb(txn.error)
      txn.oncomplete = () => {
        this.length = length
        cb(null)
      }
      if (txn.commit) txn.commit()
    }
  }

  _del (req) {
    const cb = req.callback.bind(req)
    const { codecs } = this
    const length = ((req.offset + req.size) >= this.length) ? req.offset : this.length
    const store = this._store('readwrite')

    if (req.offset >= this.length || req.size === 0) return cb(null)
    if (req.size === Infinity) req.size = Math.max(0, this.length - req.offset)

    const blocks = this._blocks(req.offset, req.offset + req.size)
    const buffers = {}
    const fstBlock = blocks.length > 0 ? blocks[0].page : 0
    const onblock = _onblock.bind(this)
    const done = _done.bind(this)

    let pending = 1

    for (let i = 0; i < blocks.length; i++) onblock(blocks[i], i)

    return done()

    function _onblock (block, i) {
      const { page, start, end } = block
      const len = end - start
      if (len === this.size) return
      pending++
      this._page(store, page, false, (err, buf) => {
        if (err || !buf) return done(err)
        b4a.fill(buf, 0, start, end)
        buffers[page - fstBlock] = buf
        return done()
      })
    }

    function _done (err) {
      if (err) return cb(err)
      if (--pending > 0) return
      for (const i in blocks) {
        const { page } = blocks[i]
        const key = codecs.page.encode(page)
        if (buffers[i]) store.put(buffers[i], key)
        else store.delete(key)
      }

      store.put(length, codecs.meta.encode('length'))

      const txn = store.transaction
      txn.onabort = () => cb(txn.error)
      txn.oncomplete = () => {
        this.length = length
        cb(null)
      }
      if (txn.commit) txn.commit()
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
}
