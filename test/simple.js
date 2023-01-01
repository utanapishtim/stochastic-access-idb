var test = require('tape')
var b4a = require('b4a')
var RAI = require('../')
var random = (name, opts) => new RAI(name, opts)

test('simple', function (t) {
  t.plan(6)
  var cool = random('cool.txt', { size: 8 })
  t.equal(cool.name, 'cool.txt')
  cool.write(100, Buffer.from('GREETINGS', 'utf-8'), function (err) {
    t.ifError(err)
    console.log('(SIMPLE FST READ)')
    cool.read(100, 9, function (err, buf) {
      t.ifError(err)
      t.equal(b4a.toString(buf, 'utf-8'), 'GREETINGS')
    })
    console.log('(SIMPLE SND READ)')
    cool.read(104, 3, function (err, buf) {
      t.ifError(err)
      t.equal(b4a.toString(buf, 'utf-8'), 'TIN')
    })
  })
})

var exitCode = 0
test.onFailure(function () {
  exitCode = 1
})

test.onFinish(function () {
  window && window.close()
  process.exit(exitCode)
})
