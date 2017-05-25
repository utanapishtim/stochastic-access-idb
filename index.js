var Abstract = require('abstract-random-access')
var inherits = require('inherits')
var nextTick = require('next-tick')
var once = require('once')
var blocks = require('./lib/blocks.js')
var bufferFrom = require('buffer-from')
var bufferAlloc = require('buffer-alloc')

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
  return function (opts) {
    if (typeof opts === 'string') opts = { name: opts }
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
  this.size = opts.size || 1024*16
  this.name = opts.name
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
    if (err) return cb(err)
    var offsets = self._blocks(offset, offset+length)
    var pending = offsets.length
    var firstBlock = offsets[0].block
    var j = 0
    for (var i = 0; i < offsets.length; i++) (function (o) {
      var key = self.name + '\0' + o.block
      backify(store.get(key), function (err, ev) {
        if (err) return cb(err)
        var b = ev.target.result.subarray(o.start,o.end)
        buffers[o.block-firstBlock] = bufferFrom(b)
        if (--pending === 0) cb(null, Buffer.concat(buffers))
      })
    })(offsets[i])
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
      var key = self.name + '\0' + o.block
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
      if (o.end-o.start === self.size) {
        block = buf.slice(j,j+len)
      } else {
        block = buffers[i]
        buf.copy(block, o.start, j+o.start, j+o.end)
      }
      store.put(block,self.name + '\0' + o.block)
      j += len
    }
    store.transaction.addEventListener('complete', function () {
      cb()
    })
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

function backify (r, cb) {
  r.addEventListener('success', function (ev) { cb(null, ev) })
  r.addEventListener('error', cb)
}
