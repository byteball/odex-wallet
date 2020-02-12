/*jslint node: true */
"use strict";

var rpc = require('json-rpc2');

var client = rpc.Client.$create(6333, '127.0.0.1');

client.call('getBalance', ['ADDR', 'base'], function(err, balance) {
	console.log('response err=',err,', balance='+balance);
});

