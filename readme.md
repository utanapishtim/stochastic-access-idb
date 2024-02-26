# stochastic-access-idb

[random-access][1]-compatible indexedDB storage layer

[![Build Status](https://travis-ci.org/random-access-storage/random-access-idb.svg?branch=master)](https://travis-ci.org/random-access-storage/random-access-idb)

[1]: https://npmjs.com/package/abstract-random-access

NB: This version is a fork of @substack's original [random-access-idb](https://github.com/substack/random-access-idb) that implements [random-access-storage](https://github.com/random-access-storage/random-access-storage) abstraction. It helps normalizing every random access instances and eases rai usage in modules like [random-access-network](https://github.com/substack/random-access-network).

Implements every [random-access-storage](https://github.com/random-access-storage/random-access-storage) method except `unlink` and `suspend`.

# example

``` js
const SAI = require('stochastic-access-idb')
const random = SAI.storage('dbname') // or, new SAI('cool.txt', { dbname: 'dbname' })
const cool = random('cool.txt')
cool.write(100, Buffer.from('GREETINGS'), function (err) {
  if (err) return console.error(err)
  cool.read(104, 3, function (err, buf) {
    if (err) return console.error(err)
    console.log(buf.toString()) // TIN
  })
})
```

# api

``` js
const SAI = require('stochastic-access-idb')
```

## var db = SAI.storage(dbname, opts)

Open an indexedDB database at `dbname`.

Any `opts` provided are forwarded to `db(name, opts)` as default options.

## var file = SAI.storage(dbname, defaultOpts)(name, opts)
## var file = new SAI(name, [opts])
## var file = new SAI({ name, ...opts })

Create a handle `file` from `name` and `opts`. Options include:

```js
{
  size: Number, // internal page size in bytes, default: 4096
  dbname: String, // name of the idb instance that backs RAI instances, default: "random-access-idb"
  version: Number, // version of idb instance, default: 1
  name: String, // name of the RAI instance to open, throws if none passed
}
```

You must keep `opts.size` the same after you've written data.
If you change the size, bad things will happen.

## file.read(offset, length, cb)

Read `length` bytes at an `offset` from `file` as `cb(err, buf)`.

## file.write(offset, buf, cb)

Write `buf` to `file` at an `offset`.

## file.del(offset, size, [cb])

Delete the specified amount of bytes at the specified offset. Optionally pass a callback that is called with (err) when the delete has completed.

## file.truncate(offset, [cb])

Truncate the storage at the specified offset. Optionally pass a callback that is called with (err) when the truncate has completed.

## file.stat(cb)

Stat the storage, returns an object to callback including:

```js
{
  size: Number, // total number of bytes in storage across all pages
  blksize: Number, // individual page size
  blocks: Number // sum of all pages byteLength divided by logical byte size (512 bytes)
}
```

## file.open([cb])

Explicitly open the storage. If you do not call this yourself, it will automatically called before any read/write/del/stat operation.

## file.close([cb])

Close the storage instance.

# install

npm install random-access-idb

# license

BSD
