const RAI = require('../')
const storage = RAI('dbname')
const cool = storage('cool.txt')

cool.write(100, Buffer.from('GREETINGS'), function (err) {
  if (err) return console.error(err)
  cool.read(104, 3, function (err, buf) {
    if (err) return console.error(err)
    console.log(buf.toString()) // TIN
  })

  cool.read(100, 9, function (err, buf) {
    if (err) return console.error(err)
    console.log(buf.toString()) // GREETINGS
  })
})
