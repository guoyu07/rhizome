var _ = require('underscore')
  , fs = require('fs')
  , async = require('async')
  , assert = require('assert')
  , moscow = require('moscow')
  , osc = require('../../../lib/server/osc')
  , connections = require('../../../lib/server/connections')
  , utils = require('../../../lib/server/core/utils')
  , shared = require('../../../lib/shared')
  , helpers = require('../../helpers')

var config = {
  webPort: 8000,
  oscPort: 9000,
  blobsPort: 33333,
  rootUrl: '/', 
  usersLimit: 5
}

var oscServer = new osc.OSCServer()

// Connects the clients, configuring blob client if necessary
var doConnection = function(clients) {
  return function(done) {
    var usingBlobClient = clients.filter(function(c) { return c.useBlobClient })
    usingBlobClient.forEach(function(c) {
      if (c.blobsPort) args = [c.appPort, 'blobClient', c.blobsPort]
      else args = [c.appPort, 'blobClient']
      sendToServer.send(shared.configureAddress, args)
    })

    helpers.dummyOSCClients(usingBlobClient.length, usingBlobClient, function(received) {
      helpers.assertSameElements(received, usingBlobClient.map(function(c) {
        return [c.appPort, shared.configuredAddress, [c.blobsPort || 44444]]
      }))
      done()
    })
  }

}

var sendToServer = new moscow.createClient('localhost', config.oscPort, 'udp')

describe('osc', function() {

  beforeEach(function(done) { oscServer.start(config, done) })
  afterEach(function(done) { helpers.afterEach([oscServer], done) })

  describe('send', function() {

    it('should transmit to osc connections subscribed to that address', function(done) {
      // List of OSC clients
      var oscClients = [
        {ip: '127.0.0.1', appPort: 9001, useBlobClient: true}, // default value should be used
        {ip: '127.0.0.1', appPort: 9002, blobsPort: 44445, useBlobClient: true},
        {ip: '127.0.0.1', appPort: 9003}
      ]

      // Adding dummy clients (simulate websockets)
      var dummyConn = { send: function(address, args) { this.received.push([address, args]) }, received: [] }
      connections.subscribe(dummyConn, '/blo')

      async.waterfall([
        doConnection(oscClients),

        // Do subscribe
        function(next) {
          sendToServer.send(shared.subscribeAddress, [9001, '/bla'])
          sendToServer.send(shared.subscribeAddress, [9002, '/'])
          helpers.dummyOSCClients(2, oscClients, next.bind(this, null))
        },

        // Checking received and sending some messages
        function(received, next) {
          helpers.assertSameElements(received, [
            [9001, shared.subscribedAddress, ['/bla']],
            [9002, shared.subscribedAddress, ['/']]
          ])
          helpers.dummyOSCClients(4, oscClients, next.bind(this, null))
          sendToServer.send('/bla', ['haha', 'hihi'])
          sendToServer.send('/blo/bli', ['non', 'oui', 1, 2])
          sendToServer.send('/empty')
        },

        // Checking the messages received
        function(received, next) {
          helpers.assertSameElements(received, [
            [9001, '/bla', ['haha', 'hihi']],
            [9002, '/bla', ['haha', 'hihi']],
            [9002, '/blo/bli', ['non', 'oui', 1, 2]],

            [9002, '/empty', []]
          ])
          assert.deepEqual(dummyConn.received, [['/blo/bli', ['non', 'oui', 1, 2]]])
          done()
        }

      ])
    })

    it('should transmit blobs to blob clients', function(done) {
      var blobClients = [
        {ip: '127.0.0.1', appPort: 44444, transport: 'tcp'}, // fake the blob client 1
        {ip: '127.0.0.1', appPort: 44445, transport: 'tcp'}, // fake the blob client 2
        {ip: '127.0.0.1', appPort: 9003, transport: 'udp'} // client 9003 is receiving blobs directly
      ]

      var oscClients = [
        {ip: '127.0.0.1', appPort: 9001, blobsPort: 44444, useBlobClient: true},
        {ip: '127.0.0.1', appPort: 9002, blobsPort: 44445, useBlobClient: true},
        {ip: '127.0.0.1', appPort: 9003}
      ]

      async.waterfall([
        doConnection(oscClients),

        // Subscribing OSC clients
        function(next) {
          sendToServer.send(shared.subscribeAddress, [9001, '/blo'])
          sendToServer.send(shared.subscribeAddress, [9002, '/blo'])
          sendToServer.send(shared.subscribeAddress, [9003, '/blo'])
          helpers.dummyOSCClients(3, oscClients, next.bind(this, null))
        },

        // Checking received and sending some messages with blobs
        function(received, next) {
          helpers.assertSameElements(received, [
            [9001, shared.subscribedAddress, ['/blo']],
            [9002, shared.subscribedAddress, ['/blo']],
            [9003, shared.subscribedAddress, ['/blo']]
          ])
          helpers.dummyOSCClients(6, blobClients, next.bind(this, null))
          sendToServer.send('/blo', [new Buffer('hahaha'), 'hihi', new Buffer('poil')])
          sendToServer.send('/blo/bli', [new Buffer('qwerty')])
        },

        // Checking the messages received
        function(received, next) {
          helpers.assertSameElements(received, [
            [44444, '/blo', [9001, new Buffer('hahaha'), 'hihi', new Buffer('poil')]],
            [44445, '/blo', [9002, new Buffer('hahaha'), 'hihi', new Buffer('poil')]],
            [9003, '/blo', [new Buffer('hahaha'), 'hihi', new Buffer('poil')]],

            [44444, '/blo/bli', [9001, new Buffer('qwerty')]],
            [44445, '/blo/bli', [9002, new Buffer('qwerty')]],
            [9003, '/blo/bli', [new Buffer('qwerty')]]
          ])
          done()
        }

      ])
    })

  })

  describe('receive a blob', function() {

    it('should request the blob client to send a blob when asked for it', function(done) {
      var oscClients = [
        {ip: '127.0.0.1', appPort: 9001, blobsPort: 44444, useBlobClient: true},
        {ip: '127.0.0.1', appPort: 9002, blobsPort: 44445, useBlobClient: true},
      ]

      var blobClients = [
        {ip: '127.0.0.1', appPort: 44444, transport: 'tcp'}, // fake the blob client 1
        {ip: '127.0.0.1', appPort: 44445, transport: 'tcp'}, // fake the blob client 2
      ]

      async.series([
        doConnection(oscClients),

        function(next) {
          // Simulate request to send a blob
          sendToServer.send(shared.sendBlobAddress, [9002, '/bla/blo', '/tmp/hihi', 11, 22, 33])

          helpers.dummyOSCClients(1, blobClients, function(received) {
            helpers.assertSameElements(received, [
              [44445, shared.sendBlobAddress, ['/bla/blo', '/tmp/hihi', 11, 22, 33]]
            ])
            done()
          })
        }
      ])

    })

    it('should return an error if invalid address', function(done) {
      var oscClients = [
        {ip: '127.0.0.1', appPort: 9001, blobsPort: 44444, useBlobClient: true}
      ]

      async.series([
        doConnection(oscClients),

        function(next) {
          // Simulate request to send a blob
          sendToServer.send(shared.sendBlobAddress, [9001, 'bla', '/tmp/hihi'])

          helpers.dummyOSCClients(1, oscClients, function(received) {
            received.forEach(function(r) {
              var args = _.last(r)
              assert.ok(_.isString(args[0]))
              args.pop()
            })
            helpers.assertSameElements(received, [
              [9001, shared.errorAddress, []]
            ])
            done()
          })
        }
      ])
    })

  })

})
