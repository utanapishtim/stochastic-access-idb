var RandomAccess = require('random-access-storage')
var inherits = require('inherits')
var nextTick = require('next-tick')
var once = require('once')
var blocks = require('./lib/blocks.js')
var b4a = require('b4a')

var DELIM = '\0'

module.exports = function (dbname, xopts) {
  if (!xopts) xopts = {}

  var win = typeof window !== 'undefined' ? window
  : (typeof self !== 'undefined' ? self : {})

  var idb = xopts.idb || (typeof win !== 'undefined'
    ? win.indexedDB || win.mozIndexedDB || win.webkitIndexedDB || win.msIndexedDB
    : null)
  if (!idb) throw new Error('indexedDB not present and not given')
  var db = null
  var dbqueue = []
  if (typeof idb.open === 'function') {
    var req = idb.open(dbname)
    req.addEventListener('upgradeneeded', function () {
      db = req.result
      db.createObjectStore('data')
    })
    req.addEventListener('success', function () {
      db = req.result
      dbqueue.forEach(function (cb) { cb(db) })
      dbqueue = null
    })
  } else {
    db = idb
  }
  return function (name, opts) {
    if (typeof name === 'object') {
      opts = name
      name = opts.name
    }

    if (!opts) opts = {}
    opts.name = name

    return new Store(Object.assign({ db: getdb }, xopts, opts))
  }
  function getdb (cb) {
    if (db) nextTick(function () { cb(db) })
    else dbqueue.push(cb)
  }
}

class Store extends RandomAccess {
  constructor (opts) {
    super(opts)
    if (!(this instanceof Store)) return new Store(opts)

    if (!opts) opts = {}
    if (typeof opts === 'string') opts = { name: opts }
    this.size = opts.size || 4096
    this.name = opts.name
    this.length = opts.length || 0
    this._getdb = opts.db
  }

  _blocks (i, j) {
    return blocks(this.size, i, j)
  }

  _read (req) {
    var self = this
    var buffers = []
    self._store('readonly', function (err, store) {
      if ((self.length || 0) < req.offset + req.size) {
        return req.callback(new Error('Could not satisfy length'), null)
      }
      if (err) return req.callback(err)
      var offsets = self._blocks(req.offset, req.offset + req.size)
      var pending = offsets.length + 1
      var firstBlock = offsets.length > 0 ? offsets[0].block : 0
      for (var i = 0; i < offsets.length; i++) (function (o) {
        var key = self.name + DELIM + o.block
        backify(store.get(key), function (err, ev) {
          if (err) return req.callback(err)
          buffers[o.block - firstBlock] = ev.target.result
            ? b4a.from(ev.target.result.subarray(o.start, o.end))
            : b4a.alloc(o.end - o.start)
          if (--pending === 0) req.callback(null, b4a.concat(buffers))
        })
      })(offsets[i])
      if (--pending === 0) req.callback(null, b4a.concat(buffers))
    })
  }

  _del (req) {
    var self = this
    var buffers = []
    self._store('readwrite', function (err, store) {
      if (err) return req.callback(err)
      var offsets = self._blocks(req.offset, Math.min(self.length, req.offset + req.size))
      var pending = offsets.length + 1
      var firstBlock = offsets.length > 0 ? offsets[0].block : 0
      var isTruncation = req.offset + req.size >= self.length
      for (var i = 0; i < offsets.length; i++) (function (o) {
        var key = self.name + DELIM + o.block
        var len = o.end - o.start

        // Delete key if truncating and its not a partial block
        if (isTruncation && (i !== 0 || len === self.size)) {
          backify(store.delete(key), function (err) {
            if (err) return req.callback(err)
            if (--pending === 0) done(store, req)
          })
        } else {
          // Get block to be zeroed
          backify(store.get(key), function (err, ev) {
            if (err) return req.callback(err)
            var block = b4a.from(ev.target.result || b4a.alloc(self.size))

            block.fill(0, o.start, o.end)

            // Commit zeros
            backify(store.put(block, self.name + DELIM + o.block), function (err) {
              if (err) return req.callback(err)
              if (--pending === 0) done(store, req)
            })
          })
        }
      })(offsets[i])
      if (--pending === 0) done(store, req)
    })

    function done (store, req) {
      // Update length in db & on object
      var length = req.offset + req.size >= self.length ? req.offset : self.length
      store.put(length, self.name + DELIM + 'length')
      store.transaction.addEventListener('complete', function () {
        self.length = length
        req.callback(null)
      })
      store.transaction.addEventListener('error', function (err) {
        req.callback(err)
      })
    }
  }

  _write (req) {
    var self = this
    self._store('readwrite', function (err, store) {
      if (err) return req.callback(err)
      var offsets = self._blocks(req.offset, req.offset + req.data.length)
      var pending = 1
      var buffers = {}
      for (var i = 0; i < offsets.length; i++) (function (o, i) {
        if (o.end - o.start === self.size) return
        pending++
        var key = self.name + DELIM + o.block
        backify(store.get(key), function (err, ev) {
          if (err) return req.callback(err)
          buffers[i] = b4a.from(ev.target.result || b4a.alloc(self.size))
          if (--pending === 0) write(store, offsets, buffers)
        })
      })(offsets[i], i)
      if (--pending === 0) write(store, offsets, buffers)
    })

    function write (store, offsets, buffers) {
      var block
      for (var i = 0, j = 0; i < offsets.length; i++) {
        var o = offsets[i]
        var len = o.end - o.start
        if (len === self.size) {
          block = b4a.from(req.data.slice(j, j + len))
        } else {
          block = buffers[i]
          b4a.copy(req.data, block, o.start, j, j + len)
        }
        store.put(block, self.name + DELIM + o.block)
        j += len
      }

      var length = Math.max(self.length || 0, req.offset + req.data.length)
      store.put(length, self.name + DELIM + 'length')
      store.transaction.addEventListener('complete', function () {
        self.length = length
        req.callback(null)
      })
      store.transaction.addEventListener('error', function (err) {
        req.callback(err)
      })
    }
  }

  _store (mode, cb) {
    cb = once(cb)
    var self = this
    self._getdb(function (db) {
      var tx = db.transaction(['data'], mode)
      var store = tx.objectStore('data')
      tx.addEventListener('error', cb)
      cb(null, store)
    })
  }

  _open (req) {
    var self = this
    this._getdb(function (db) {
      self._store('readonly', function (err, store) {
        if (err) return req.callback(err)
        backify(store.get(self.name + DELIM + 'length'), function (err, ev) {
          if (err) return req.callback(err)
          self.length = ev.target.result || 0
          req.callback(null)
        })
      })
    })
  }

  _close (req) {
    this._getdb(function (db) {
      //db.close() // TODO: reopen gracefully. Close breaks with corestore, as innercorestore closes the db
      return req.callback(null)
    })
  }

  _stat (req) {
    var self = this
    nextTick(function () {
      req.callback(null, { size: self.length })
    })
  }
}

function backify (r, cb) {
  r.addEventListener('success', function (ev) { cb(null, ev) })
  r.addEventListener('error', cb)
}
