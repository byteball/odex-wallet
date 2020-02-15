const crypto = require('crypto');
const async = require('async');
const constants = require('ocore/constants.js');
const objectHash = require('ocore/object_hash.js');
const eventBus = require('ocore/event_bus.js');
const mutex = require('ocore/mutex.js');
const db = require('ocore/db.js');
const conf = require('ocore/conf.js');
const headlessWallet = require('headless-obyte');
const operator = require('./operator.js');
const operator_wallet = require('./operator_wallet.js');
const mongo = require('./mongo.js');
const trades = require('./trades.js');
const replication = require('./replication.js');

let arrQueuedTrades = [];
let bInitializedQueue = false;


function executeTrade(matches, cb) {
	if (!cb)
		return new Promise(function (resolve) {
			executeTrade(matches, (err, arrTriggerUnits) => {
				resolve([err, arrTriggerUnits]);
			});
		});
	mutex.lock(['trade'], unlock => {
		doExecuteTrade(matches, (err, arrTriggerUnits) => {
			cb(err, arrTriggerUnits);
			unlock();
		});
	});
}

function doExecuteTrade(matches, cb) {
	console.error('executeTrade', JSON.stringify(matches, null, '\t'));
	if (!bInitializedQueue)
		return eventBus.once('initialized_trade_queue', () => {
			doExecuteTrade(matches, cb);
		});
	let { err, bMyTrade, taker_order, maker_orders } = trades.parseTrade(matches);
	if (err)
		return cb(err);
	if (!bMyTrade)
		throw Error("foreign matcher");
	if (arrQueuedTrades.length > 0) { // earlier trades need to be sent first
		arrQueuedTrades.push(matches);
		return cb("queued trades ahead", []);
	}
	sendTradeTx(maker_orders, taker_order, async (err, arrTriggerUnits, arrAddresses) => {
		if (err && arrTriggerUnits.length > 0) // if some trades were sent, return a success
			err = null;
		if (arrTriggerUnits.length > 0)
			await updateTrades(matches.trades, arrTriggerUnits);
		if (arrTriggerUnits.length < maker_orders.length) {
			let queued_trade = {
				takerOrder: matches.takerOrder,
				makerOrders: matches.makerOrders.slice(arrTriggerUnits.length),
				trades: matches.trades.slice(arrTriggerUnits.length),
			};
			arrQueuedTrades.push(queued_trade);
		}
		cb(err, arrTriggerUnits);
		arrAddresses.forEach(address => {
			eventBus.emit('refresh_balances', address, 'submitted_trade');
		});
		if (arrTriggerUnits.length > 0)
			replication.createAndBroadcastEvent('trade', getSuccessfulMatches(matches, arrTriggerUnits));
	});
}

function sendTradeTx(maker_orders, taker_order, cb) {
	if (!cb)
		return new Promise(resolve => {
			sendTradeTx(maker_orders, taker_order, (err, arrTriggerUnits, arrAddresses) => {
				resolve({ err, arrTriggerUnits, arrAddresses });
			});
		});
	let arrAddresses = [taker_order.signed_message.address];
	let arrTriggerUnits = [];
	async.eachSeries(
		maker_orders,
		function (maker_order, cb2) {
			let message = {
				app: 'data',
				payload_location: 'inline',
				payload: {
					order1: maker_order,
					order2: taker_order,
				}
			};
			message.payload_hash = objectHash.getBase64Hash(message.payload, true);
			let opts = {
				messages: [message],
				amount: constants.MIN_BYTES_BOUNCE_FEE,
				to_address: conf.aa_address,
				paying_addresses: [operator.getAddress()],
				change_address: operator.getAddress(),
				spend_unconfirmed: 'all',
			};
			headlessWallet.sendMultiPayment(opts, (err, unit) => {
				console.error('---- tx submission result: err=' + err + ', unit=' + unit);
				if (err)
					return cb2(err);
				arrTriggerUnits.push(unit);
				let address = maker_order.signed_message.address;
				if (!arrAddresses.includes(address))
					arrAddresses.push(address);
				cb2();
			});
		},
		async function (err) {
			if (err)
				console.error(err);
			if (arrTriggerUnits.length === 0)
				arrAddresses = [];
			cb(err, arrTriggerUnits, arrAddresses);
			if (Date.now() % 10 === 0)
				operator_wallet.checkBalance();
		}
	);
}

async function resendQueuedTrades(onDone) {
	console.error('resendQueuedTrades ' + arrQueuedTrades.length + ' trades queued');
	if (arrQueuedTrades.length === 0)
		return onDone();
	let matches = arrQueuedTrades[0];
	let taker_order = matches.takerOrder.originalOrder;
	let maker_orders = matches.makerOrders.map(be_maker_order => be_maker_order.originalOrder);
	let { err, arrTriggerUnits, arrAddresses } = await sendTradeTx(maker_orders, taker_order);
	if (err) {
		if (arrTriggerUnits.length === maker_orders.length)
			throw Error("all orders executed but still an error: " + err);
		if (arrTriggerUnits.length === 0)
			return onDone();
	}
	else {
		if (arrTriggerUnits.length !== maker_orders.length)
			throw Error("no error but got " + arrTriggerUnits.length + " triggers for " + maker_orders.length + " makers");
	}
	let trade_hashes = await updateTrades(matches.trades, arrTriggerUnits);
	eventBus.emit('submitted_trades', { trade_hashes });
	arrAddresses.forEach(address => {
		eventBus.emit('refresh_balances', address, 'submitted_trade');
	});
	if (arrTriggerUnits.length > 0)
		replication.createAndBroadcastEvent('trade', getSuccessfulMatches(matches, arrTriggerUnits));
	if (err) {
		matches.makerOrders.splice(0, arrTriggerUnits.length);
		matches.trades.splice(0, arrTriggerUnits.length);
	}
	else
		arrQueuedTrades.shift();
	if (!err && arrQueuedTrades.length > 0) // go to next trade
		resendQueuedTrades(onDone);
}

function resendQueuedTradesUnderLock() {
	mutex.lock(['resendQueuedTradesUnderLock'], resendQueuedTrades);
}

async function updateTrades(trades, arrTriggerUnits) {
	let mongodb = await mongo.getMongo();
	let trade_hashes = [];
	for (let i = 0; i < arrTriggerUnits.length; i++) {
		const hash = trades[i].hash;
		await mongodb.collection('trades').updateOne({ hash }, { $set: { status: 'SUCCESS', txHash: arrTriggerUnits[i] } });
		trades[i].txHash = arrTriggerUnits[i];
		trades[i].status = "SUCCESS";
		trade_hashes.push(hash);
	}
	return trade_hashes;
}

function getSuccessfulMatches(matches, arrTriggerUnits) {
	let len = arrTriggerUnits.length;
	if (len === matches.makerOrders.length)
		return matches;
	return {
		takerOrder: matches.takerOrder,
		makerOrders: matches.makerOrders.slice(0, len),
		trades: matches.trades.slice(0, len),
	};
}

function sha256(str) {
	return crypto.createHash("sha256").update(str, "utf8").digest("base64");
}


async function initQueue() {
	let mongodb = await mongo.getMongo();
	let trades = await mongodb.collection('trades').find({ status: "PENDING" }).sort({ createdAt: 1, _id: 1 }).toArray();
	for (let i = 0; i < trades.length; i++){
		let trade = trades[i];
		if (trade.txHash)
			throw Error("trade " + trade.hash + " already sent in " + trade.txHash);
		let takerOrder = await mongodb.collection('orders').findOne({ hash: trade.takerOrderHash });
		if (!takerOrder)
			throw Error("taker order " + trade.takerOrderHash + " not found");
		if (takerOrder.originalOrder.signed_message.matcher !== operator.getAddress())
			throw Error("wrong matcher in taker order " + trade.takerOrderHash);
		let makerOrder = await mongodb.collection('orders').findOne({ hash: trade.makerOrderHash });
		if (!makerOrder)
			throw Error("maker order " + trade.makerOrderHash + " not found");
		if (makerOrder.originalOrder.signed_message.matcher !== operator.getAddress())
			throw Error("wrong matcher in maker order " + trade.makerOrderHash);
		cleanFromMongo(takerOrder);
		cleanFromMongo(makerOrder);
		cleanFromMongo(trade);
		let matches = {
			takerOrder,
			makerOrders: [makerOrder],
			trades: [trade],
		};

		// make sure the trade was not already sent
		let payload = {
			order1: makerOrder.originalOrder,
			order2: takerOrder.originalOrder,
		};
		let payload_hash = objectHash.getBase64Hash(payload, true);
		let rows = await db.query("SELECT unit FROM unit_authors CROSS JOIN messages USING(unit) WHERE address=? AND payload_hash=?", [operator.getAddress(), payload_hash]);
		if (rows.length > 0) {
			// looks like the daemon crashed before the trade status was updated, update now
			if (rows.length > 1)
				console.error("trade " + trade.hash + " already sent " + rows.length + " times");
			let trigger_unit = rows[0].unit;
			console.error("trade " + trade.hash + " already sent in unit " + trigger_unit);
			await mongodb.collection('trades').updateOne({ hash: trade.hash }, { $set: { status: 'SUCCESS', txHash: trigger_unit } });
			replication.createAndBroadcastEvent('trade', matches);
			continue;
		}

		arrQueuedTrades.push(matches);
	}
	bInitializedQueue = true;
	eventBus.emit('initialized_trade_queue');
}

function cleanFromMongo(obj) {
	delete obj._id;
	delete obj.createdAt;
	delete obj.updatedAt;
}

async function start() {
	await initQueue();
	resendQueuedTradesUnderLock();
	eventBus.on('my_transactions_became_stable', resendQueuedTradesUnderLock);
	eventBus.on('withdrawal_to_operator', resendQueuedTradesUnderLock);
}




exports.start = start;
exports.executeTrade = executeTrade;

