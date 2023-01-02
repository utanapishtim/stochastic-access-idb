var test = require('tape')
var b4a = require('b4a')
var RAI = require('../')
var random = RAI.legacy('testing-' + Math.random(), { size: 5 })

test('simple', function (t) {
  t.plan(6)
  var cool = random('cool.txt', { size: 5 })
  t.equal(cool.name, 'cool.txt')
  cool.write(100, Buffer.from('GREETINGS', 'utf-8'), function (err) {
    t.ifError(err)
    cool.read(100, 9, function (err, buf) {
      t.ifError(err)
      t.equal(b4a.toString(buf, 'utf-8'), 'GREETINGS')
    })
    cool.read(104, 3, function (err, buf) {
      t.ifError(err)
      t.equal(b4a.toString(buf, 'utf-8'), 'TIN')
    })
  })
})

let exitCode = 0
test.onFailure(function () {
  exitCode = 1
})

test.onFinish(function () {
  window && window.close()
  process.exit(exitCode)
})
