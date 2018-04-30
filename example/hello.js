var random = require('../')('dbname')
var cool = random('cool.txt')
cool.write(100, Buffer.from('GREETINGS'), function (err) {
  if (err) return console.error(err)
  cool.read(104, 3, function (err, buf) {
    if (err) return console.error(err)
    console.log(buf.toString()) // TIN
  })
})
