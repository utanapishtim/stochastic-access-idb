# random-access-idb

[random-access][1]-compatible indexedDB storage layer

[![Build Status](https://travis-ci.org/random-access-storage/random-access-idb.svg?branch=master)](https://travis-ci.org/random-access-storage/random-access-idb)

[1]: https://npmjs.com/package/abstract-random-access

NB: This version is a fork of @substack's original [random-access-idb](https://github.com/substack/random-access-idb) that implements [random-access-storage](https://github.com/random-access-storage/random-access-storage) abstraction. It helps normalizing every random access instances and eases rai usage in modules like [random-access-network](https://github.com/substack/random-access-network).

Substack's `idb.close()` function is removed from this branch as it appears to conflict with how [Corestore](https://github.com/andrewosh/corestore) opens and closes the RandomAccess Store, until further work can be done to gracefully handle closing state.

# example

``` js
var random = require('random-access-idb')('dbname')
var cool = random('cool.txt')
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
var random = require('random-access-idb')
```

## var db = random(dbname, opts)

Open an indexedDB database at `dbname`.

Any `opts` provided are forwarded to `db(name, opts)` as default options.

## var file = db(name, opts)

Create a handle `file` from `name` and `opts`:

* `opts.size` - internal chunk size to use (default 4096)

You must keep `opts.size` the same after you've written data.
If you change the size, bad things will happen.

## file.read(offset, length, cb)

Read `length` bytes at an `offset` from `file` as `cb(err, buf)`.

## file.write(offset, buf, cb)

Write `buf` to `file` at an `offset`.

# install

npm install random-access-idb

# license

BSD
