/*jslint node: true */
"use strict";

const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');

const operator = require('./operator.js');
const operator_wallet = require('./operator_wallet.js');
const replication = require('./replication.js');
const trade_queue = require('./trade_queue.js');
const dagState = require('./dag_state.js');
const rpc = require('./rpc.js');
const chat = require('./chat.js');
const matcherBackend = require('./matcher_backend.js');


eventBus.on('headless_wallet_ready', async () => {
	await operator.start();

	rpc.start();
	await matcherBackend.start();
	dagState.startWatching();
	await replication.start();
	await trade_queue.start();
	chat.start();
	network.start();
	await operator_wallet.start();
});

process.on('unhandledRejection', up => { throw up; });
