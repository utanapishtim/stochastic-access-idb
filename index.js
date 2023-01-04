const RandomAccessStorage = require('random-access-storage')
const isOptions = require('is-options')
const b4a = require('b4a')
const cenc = require('compact-encoding')
const mutexify = require('mutexify')
const debug = require('nanodebug')({ enabled: false })
const queuetick = require('queue-tick')

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
  lock = mutexify()

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
    debug('constructor', name, opts)
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
    debug('_open')
    const cb = req.callback.bind(req)
    this.lock((release) => {
      const open = this.indexedDB.open(this.id, this.version)
  
      open.onerror = onerror
      open.onsuccess = onopen.bind(this)
      open.onupgradeneeded = onupgradeneeded.bind(this)

      function onerror () {
        release(cb, open.error || new Error('error opening indexedDB'))
      }

      function onopen () {
        this.db = open.result
        release() // release the lock before performing any db ops
        this._keys((err, keys) => {
          if (err) return cb(err)
          this._length(keys, (err, len) => {
            if (err) return cb(err)
            this.length = len
            return cb(null)
          })
        })
      }

      function onupgradeneeded (event) {
        const db = event.target.result
        if (!db.objectStoreNames.contains(this.name)) db.createObjectStore(this.name)
      }
    })
  }

  _close (req) {
    debug('_close')
    const cb = req.callback.bind(req)
    this.write(this.length, b4a.alloc(0), (err) => {
      if (err) return cb(err)
      this.lock((release) => {
        this.db.close()
        return release(cb, null)
      })
    })
  }

  _stat (req) {
    debug('_stat')
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
    debug('_read', req.offset, req.size, this.length)
    let idx = Math.floor(req.offset / this.size) // index of page
    let rel = req.offset - idx * this.size // page-relative start
    let start = 0

    if (req.offset + req.size > this.length) {
      return req.callback(new Error('Could not satisfy length'), null)
    }

    const data = b4a.alloc(req.size)

    const onpage = (err, page) => {
      if (err) return req.callback(err)
      debug('_read/onpage')
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

    return this._page(cenc.encode(cenc.lexint, idx), false, onpage)
  }

  _write (req) {
    debug('_write', req.offset, req.size, this.size)
    let idx = Math.floor(req.offset / this.size) 
    let rel = req.offset - idx * this.size
    let start = 0

    const len = req.offset + req.size
    debug('_write/len')
    const ops = []

    const onpage = (err, page) => {
      debug('write/_onpage')
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

    return this._page(cenc.encode(cenc.lexint, idx), true, onpage)
  }

  _del (req) {
    debug('_del')
    if (req.offset >= this.length) return req.callback(new Error('Could not delete: offset does not exist'))

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
      if (err) return req.callback(err)

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
      if (err) return req.callback(err)
      b4a.fill(page, 0, 0, lstidx)
      ops.push({ type: 'put', key: cenc.encode(cenc.lexint, lstpage), value: page })
      return batch.apply(this)
    }

    function batch () {
      this._batch(ops, (err) => {
        if (err) return req.callback(err)
        if (req.offset + req.size >= this.length) this.length = req.offset
        return req.callback(null)
      })
    }
  }

  _unlink (req) {
    debug('_unlink')
    const cb = req.callback.bind(req)
    this.lock((release) => {
      const store = this._store('readwrite')
      const clear = store.clear()
      clear.onerror = () => release(cb, clear.error)
      clear.onsuccess = () => {
        const del = this.indexedDB.deleteDatabase(this.id)
        del.onerror = () => release(cb, del.error)
        del.onsuccess = () => release(cb, null)
      }
    })
  }

  _page (key, upsert, cb) {
    debug('_page')
    this._get(key, (err, page) => {
      if (err) return cb(err)
      if (page || !upsert) return cb(null, page)
      page = b4a.alloc(this.size)
      return cb(null, page)
    })
  }

  _store (mode) {
    debug('_store')
    const txn = this.db.transaction([this.name], mode)
    const objstore = txn.objectStore(this.name)
    return objstore
  }

  _get (key, cb) {
    debug('_get')
    this.lock((release) => {
      // const release = (cb, e, d) => cb(e, d)
      try {
        const store = this._store('readonly')
        const req = store.get(key)
        const txn = req.transaction
        txn.onabort = () => release(cb, txn.error || new Error('idb get aborted'))
        txn.oncomplete = () => release(cb, null, req.result)
      } catch (err) {
        return cb(err)
      }
    })
  }

  _batch (ops = [], cb) {
    debug('_batch')
    this.lock((release) => {
      const store = this._store('readwrite')
      const txn = store.transaction
      let idx = 0
      let error = null
      txn.onabort = () => release(cb, error || txn.error || new Error('idb batch op aborted'))
      txn.oncomplete = () => {
        console.log('completing')
        return release(cb, null)
      }
  
      function next () {
        const op = ops[idx++]
        const { type, key, value } = op
        try {
          const req = (type === 'del') ? store.delete(key) : store.put(value, key)
          req.onerror = (err) => console.error(`batch error: ${err}`)
          if (idx < ops.length) req.onsuccess = next
          else if (typeof txn.commit === 'function') {
            console.log('committing')
            txn.commit()
          }
        } catch (err) {
          error = err
          txn.abort()
          return
        }
      }
  
      next()
    })
  }

  _keys (cb) {
    debug('_keys')
    const store = this._store('readonly')
    const req = store.getAllKeys()
    req.onerror = () => cb(req.error)
    req.onsuccess = () => cb(null, req.result.map((arrbuf) => new Uint8Array(arrbuf)))
  }

  _length (keys, cb) {
    debug('_length')
    if (keys.length === 0) return cb(null, 0)
    let kIndex = keys.length - 1
    this._get(keys[kIndex], onpage.bind(this))
     
    function onpage (err, page) {
      if (err) return cb(err)
      for (let bIndex = page.length - 1; bIndex >= 0; bIndex--) {
        if (page[bIndex] !== 0) continue
        const pIndex = cenc.decode(cenc.lexint, keys[kIndex])
        return cb(null, (pIndex * this.size) - (page.length - bIndex))
      }

      if (--kIndex >= 0) return this._get(keys[kIndex], onpage.bind(this))
      return cb(null, 0)
    }
  }
}
