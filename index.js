var Abstract = require('abstract-random-access')
var inherits = require('inherits')
var nextTick = require('next-tick')
var once = require('once')
var blocks = require('./lib/blocks.js')
var bufferFrom = require('buffer-from')
var bufferAlloc = require('buffer-alloc')

var DELIM = '\0'

module.exports = function (dbname, xopts) {
  if (!xopts) xopts = {}
  var idb = xopts.idb || (typeof window !== 'undefined'
    ? window.indexedDB || window.mozIndexedDB
      || window.webkitIndexedDB || window.msIndexedDB
    : null)
  if (!idb) throw new Error('indexedDB not present and not given')
  var db = null, dbqueue = []
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

function Store (opts) {
  if (!(this instanceof Store)) return new Store(opts)
  Abstract.call(this)
  if (!opts) opts = {}
  if (typeof opts === 'string') opts = { name: opts }
  this.size = opts.size || 4096
  this.name = opts.name
  this.length = opts.length || 0
  this._getdb = opts.db
}
inherits(Store, Abstract)

Store.prototype._blocks = function (i, j) {
  return blocks(this.size, i, j)
}

Store.prototype._read = function (offset, length, cb) {
  var self = this
  cb = once(cb)
  var buffers = []
  self._store('readonly', function (err, store) {
    backify(store.get(self.name + DELIM + "length"), function(err, ev) {
      if ((ev.target.result || 0) < offset+length) {
        return cb(new Error('Could not satisfy length'))
      }
      if (err) return cb(err)
      var offsets = self._blocks(offset, offset+length)
      var pending = offsets.length + 1
      var firstBlock = offsets.length > 0 ? offsets[0].block : 0
      var j = 0
      for (var i = 0; i < offsets.length; i++) (function (o) {
        var key = self.name + DELIM + o.block
        backify(store.get(key), function (err, ev) {
          if (err) return cb(err)
          buffers[o.block-firstBlock] = ev.target.result
            ? bufferFrom(ev.target.result.subarray(o.start,o.end))
            : bufferAlloc(o.end-o.start)
          if (--pending === 0) cb(null, Buffer.concat(buffers))
        })
      })(offsets[i])
      if (--pending === 0) cb(null, Buffer.concat(buffers))
    })
  })
}

Store.prototype._write = function (offset, buf, cb) {
  var self = this
  cb = once(cb)
  self._store('readwrite', function (err, store) {
    if (err) return cb(err)
    var offsets = self._blocks(offset, offset + buf.length)
    var pending = 1
    var buffers = {}
    for (var i = 0; i < offsets.length; i++) (function (o,i) {
      if (o.end-o.start === self.size) return
      pending++
      var key = self.name + DELIM + o.block
      backify(store.get(key), function (err, ev) {
        if (err) return cb(err)
        buffers[i] = bufferFrom(ev.target.result || bufferAlloc(self.size))
        if (--pending === 0) write(store, offsets, buffers)
      })
    })(offsets[i],i)
    if (--pending === 0) write(store, offsets, buffers)
  })
  function write (store, offsets, buffers) {
    for (var i = 0, j = 0; i < offsets.length; i++) {
      var o = offsets[i]
      var len = o.end - o.start
      if (len === self.size) {
        block = buf.slice(j,j+len)
      } else {
        block = buffers[i]
        buf.copy(block, o.start, j, j+len)
      }
      store.put(block,self.name + DELIM + o.block)
      j += len
    }
    var length = Math.max(self.length || 0, offset + buf.length)
    store.put(length, self.name + DELIM + "length")
    store.transaction.addEventListener('complete', function () {
      self.length = length
      cb(null)
    })
    store.transaction.addEventListener('error', cb)
  }
}

Store.prototype._store = function (mode, cb) {
  cb = once(cb)
  var self = this
  self._getdb(function (db) {
    var tx = db.transaction(['data'], mode)
    var store = tx.objectStore('data')
    tx.addEventListener('error', cb)
    cb(null, store)
  })
}

Store.prototype._open = function(cb) {
  var self = this
  this._getdb(function(db) {
    self._store('readonly', function (err, store) {
      backify(store.get(self.name + DELIM + "length"), function(err, ev) {
        self.length = ev.target.result || 0
        cb(null)
      })
    })
  })
}

function backify (r, cb) {
  r.addEventListener('success', function (ev) { cb(null, ev) })
  r.addEventListener('error', cb)
}
