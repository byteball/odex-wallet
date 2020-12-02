const _ = require('lodash');
const objectHash = require('ocore/object_hash.js');
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const db = require('ocore/db.js');
const mutex = require('ocore/mutex.js');
const conf = require('ocore/conf.js');

const mongo = require('./mongo.js');
const operator = require('./operator.js');
const signing = require('./signing.js');
const orders = require('./orders.js');
const cancels = require('./cancels.js');
const trades = require('./trades.js');
const userSignedMessages = require('./user_signed_messages.js');

let mongodb;

let assocWsPeers = {};
let prev_event_hash;
let last_id;
let since;
let assocLastEventHashes = {};


function createAndBroadcastEvent(type, payload) {
	let event = {
		type,
		origin: operator.getAddress(),
		ts: Date.now(),
		payload,
	};
	if (prev_event_hash)
		event.prev_event_hash = prev_event_hash;
	console.error('event', require('util').inspect(event, true, null));
	event.event_hash = objectHash.getBase64Hash(event, true);
	prev_event_hash = event.event_hash;
	signing.signMessage(event, async (err, objSignedEvent) => {
		if (err)
			throw Error("failed to sign event");
		last_id++;
		console.log('last_id', last_id);
		objSignedEvent._id = last_id;
		try {
			await mongodb.collection('events').insertOne(objSignedEvent, { checkKeys: false });
		}
		catch (e) {
			console.error("error while inserting a new event: ", e);
			throw e;
		}
		delete objSignedEvent._id;
		assocLastEventHashes[event.origin] = event.event_hash;
		broadcastMessage({ signed_event: objSignedEvent });
	});
}

function broadcastMessage(obj, from_ws) {
	for (let peer in assocWsPeers) {
		const ws = assocWsPeers[peer];
		if (ws !== from_ws)
			network.sendJustsaying(ws, 'custom', obj);
	}
}

function sendCustomRequest(ws, params) {
	return new Promise(resolve => {
		network.sendRequest(ws, 'custom', params, false, (ws, request, response) => {
			resolve(response);
		});
	});
}

async function initFromPeers() {
	for (let peer in assocWsPeers) {
		const ws = assocWsPeers[peer];
		const response = await sendCustomRequest(ws, { command: 'init' });
		if (response.error)
			return console.log("error from " + peer + ": " + response.error);
		const arrOrders = response.orders || [];
		const arrTrades = response.trades || [];
		if (!Array.isArray(arrOrders))
			return console.log("orders is not an array");
		if (!Array.isArray(arrTrades))
			return console.log("trades is not an array");
		await handleInitialOrders(arrOrders);
		await handleInitialTrades(arrTrades);
		await mongodb.collection('status').updateOne({ _id: 1 }, { $set: { initialized: true } }, { upsert: true });
	}
}

async function handleInitialOrders(arrOrders) {
	try {
		for (var i = 0; i < arrOrders.length; i++) {
			let order = arrOrders[i];
			let existing_order = await mongodb.collection('orders').findOne({ hash: order.hash });
			if (existing_order)
				continue;
			let err = await orders.handleSignedOrder(order.originalOrder, order.matcherAddress);
			if (err)
				return console.log("bad order: " + err);
			let be_order = await orders.getBackendOrder(order.originalOrder);
			if (!orders.ordersAreEqual(be_order, order))
				return console.log("received and derived order are not the same:\nreceived " + JSON.stringify(order, null, '\t') + "\nderived\n" + JSON.stringify(be_order, null, '\t'));
			order.createdAt = new Date(order.createdAt);
			order.updatedAt = new Date(order.updatedAt);
				// this will update partially filled orders
			await mongodb.collection('orders').updateOne({ hash: be_order.hash }, { $set: order }, { upsert: true, checkKeys: false });
		}
	}
	catch (e) {
		console.log("exception: " + e);
	}
}


async function handleInitialTrades(arrTrades) {
	try {
		for (var i = 0; i < arrTrades.length; i++) {
			let trade = arrTrades[i];
			let existing_trade = await mongodb.collection('trades').findOne({ hash: trade.hash });
			if (existing_trade)
				continue;
			trade.createdAt = new Date(trade.createdAt);
			trade.updatedAt = new Date(trade.updatedAt);
			try {
				await mongodb.collection('trades').insertOne(trade);
			}
			catch (e) {
				console.log("insert exception: " + e);
			}
		}
	}
	catch (e) {
		console.log("exception: " + e);
	}
}

async function requestUnresolvedEventsFromAllPeers() {
	if (Object.keys(assocWsPeers).length === 0)
		return setTimeout(requestUnresolvedEventsFromAllPeers, 30 * 1000);
	for (let peer in assocWsPeers) {
		const ws = assocWsPeers[peer];
		await requestUnresolvedEvents(ws);
	}
}

async function requestUnresolvedEvents(ws) {
	let arrEvents = await mongodb.collection('unhandled_events').find().sort({ 'signed_message.ts': -1 }).toArray();
	let arrHashes = arrEvents.map(objSignedEvent => objSignedEvent.signed_message.event_hash);
	for (let i = 0; i < arrEvents.length; i++){
		const objSignedEvent = arrEvents[i];
		const prev_event_hash = objSignedEvent.signed_message.prev_event_hash;
		if (arrHashes.includes(prev_event_hash)) // we already have it
			return;
		await requestEvent(ws, prev_event_hash);
	}
}

async function requestEvent(ws, event_hash) {
	const response = await sendCustomRequest(ws, { command: 'get_event', params: { event_hash } });
	if (response.error) // it'll be referenced again and requested again
		return console.log("error from " + ws.peer + ": " + response.error);
	await handleEventUnderLock(ws, response.signed_event);
}

async function handleEventUnderLock(ws, objSignedEvent) {
	if (!objSignedEvent || !objSignedEvent.signed_message || !objSignedEvent.signed_message.event_hash || typeof objSignedEvent.signed_message.event_hash != "string")
		return "no event_hash";
	const unlock = await mutex.lock(objSignedEvent.signed_message.event_hash); // returns unlock callback
	const err = await handleEvent(ws, objSignedEvent);
	unlock();
	return err;
}

async function handleEvent(ws, objSignedEvent) {
	if (!objSignedEvent)
		return 'no event';		
	try {
		var origin_address = objSignedEvent.authors[0].address;
		if (origin_address === operator.getAddress())
			return "my own order echoed back to me";
		var event = objSignedEvent.signed_message;
		if (event.origin !== origin_address)
			return "origin mismatch";
		if (event.type !== 'order' && event.type !== 'cancel' && event.type !== 'trade')
			return "not an order or cancel";
		const stripped_event = _.clone(event);
		delete stripped_event.event_hash;
		if (event.event_hash !== objectHash.getBase64Hash(stripped_event, true))
			return "bad event_hash";
		if (!event.payload)
			return "no payload";
		if (event.type === 'order' || event.type === 'cancel') {
			var objSignedMessage = event.payload;
			const type = userSignedMessages.getSignedMessageType(objSignedMessage.signed_message);
			if (type !== event.type)
				return "event type doesn't match message type";
		}
		else { // trade
			var matches = event.payload;
			const taker_order = matches.takerOrder.originalOrder;
			const matcher = taker_order.signed_message.matcher;
			if (matcher !== origin_address)
				return "matcher is not origin address";
		}
	}
	catch (e) {
		return 'broken signed event: ' + e;
	}

	if (await mongodb.collection('events').findOne({ 'signed_message.event_hash': event.event_hash }))
		return "event " + event.event_hash + " already known";

	let err = await signing.validateSignedMessage(objSignedEvent);
	if (err)
		return 'bad origin signature: ' + err;
	
	if (event.prev_event_hash) {
		let prev_event = await mongodb.collection('events').findOne({ 'signed_message.event_hash': event.prev_event_hash });
		if (prev_event && prev_event.signed_message.origin !== event.origin)
			return "previous event has a different origin " + prev_event.signed_message.origin;
		if (!prev_event && event.ts >= since) {
			console.log("prev event unknown, will request " + event.prev_event_hash);
			try {
				await mongodb.collection('unhandled_events').insertOne(objSignedEvent, {checkKeys: false});
			}
			catch (e) { // ignore duplicate
				console.log("error from inserting unhandled: " + e);
			}
			requestEvent(ws, event.prev_event_hash);
			return "prev_event_hash unknown, will request";
		}
	}
	
	switch (event.type) {
		case 'order':
			err = await orders.handleSignedOrder(objSignedMessage, origin_address);
			if (err)
				console.log('bad user order: ' + err); // order may be invalid because expired
			break;
		case 'cancel':
			err = await cancels.handleSignedCancel(objSignedMessage, null);
			if (err)
				return 'bad user cancel: ' + err;
			break;
		case 'trade':
			err = await executeReplicatedTrade(matches, origin_address);
			// it might fail due to various reasons such as a pair not being registered on our node.
			// accept the event but don't forward it
			if (err)
				console.error('bad trade: ' + err);
		//		return 'bad trade: ' + err;
			break;
	}

	last_id++;
	objSignedEvent._id = last_id;
	await mongodb.collection('events').insertOne(objSignedEvent, {checkKeys: false});
	delete objSignedEvent._id;
	assocLastEventHashes[event.origin] = event.event_hash;

	// look for next events that depend on this event
	let arrNextEvents = await mongodb.collection('unhandled_events').find({ 'signed_message.prev_event_hash': event.event_hash }).toArray();
	arrNextEvents.forEach(async (objNextSignedEvent) => {
		await mongodb.collection('unhandled_events').deleteOne({ 'signed_message.event_hash': objNextSignedEvent.signed_message.event_hash });
		delete objNextSignedEvent._id;
		handleEventUnderLock(ws, objNextSignedEvent);
	});

	// might return an error from trade
	return err;
}

async function executeReplicatedTrade(matches, origin_address) {
	let { err, bMyTrade, addresses } = trades.parseTrade(matches);
	if (err)
		return err;
	if (bMyTrade)
		throw Error("my trade in executeReplicatedTrade");
	
	// validate taker
	let taker_be_order = matches.takerOrder;
	let pairName = taker_be_order.pairName;
	let baseToken = taker_be_order.baseToken;
	let quoteToken = taker_be_order.quoteToken;
	let taker_order_data = taker_be_order.originalOrder.signed_message;
	let [taker_order, err2] = await readOrAddOrder(taker_be_order, origin_address);
	if (err2)
		return err2;
	if (taker_order.hash !== taker_be_order.hash)
		throw Error("hash mismatch");
	if (taker_order_data.matcher !== origin_address)
		return "origin of the trade is different from matcher of taker order";
	
	// validate makers
	for (let i = 0; i < matches.makerOrders.length; i++){
		let be_order = matches.makerOrders[i];
		let order_data = be_order.originalOrder.signed_message;
		if (be_order.pairName !== pairName)
			return "pair mismatch for maker " + i;
		if (be_order.baseToken !== baseToken)
			return "baseToken mismatch for maker " + i;
		if (be_order.quoteToken !== quoteToken)
			return "quoteToken mismatch for maker " + i;
		if (order_data.sell_asset !== taker_order_data.buy_asset || order_data.buy_asset !== taker_order_data.sell_asset)
			return "asset mismatch";
		let round_trip_amount = Math.round(order_data.price * taker_order_data.price * order_data.sell_amount);
		if (round_trip_amount > order_data.sell_amount)
			return "price mismatch " + round_trip_amount + " > " + order_data.sell_amount;
		let [maker_order, err] = await readOrAddOrder(be_order, origin_address);
		if (err)
			return err;
		if (maker_order.hash !== be_order.hash)
			throw Error("hash mismatch");
		if (order_data.matcher !== origin_address)
			return "origin of the trade is different from matcher of maker order";
	}

	// validate trades
	for (let i = 0; i < matches.trades.length; i++){
		let trade = matches.trades[i];
		let unit = trade.txHash;
		if (!unit)
			return "no txHash in trade " + i;
		if (trade.pairName !== pairName)
			return "pair mismatch for trade " + i;
		if (trade.baseToken !== baseToken)
			return "baseToken mismatch for trade " + i;
		if (trade.quoteToken !== quoteToken)
			return "quoteToken mismatch for trade " + i;
		if (trade.takerOrderHash !== taker_be_order.hash)
			return "taker hash mismatch for trade " + i;
		if (trade.taker !== taker_be_order.userAddress)
			return "taker address mismatch for trade " + i;
		if (trade.makerOrderHash !== matches.makerOrders[i].hash)
			return "maker hash mismatch for trade " + i;
		if (trade.maker !== matches.makerOrders[i].userAddress)
			return "maker address mismatch for trade " + i;
		if (trade.price !== matches.makerOrders[i].price)
			return "price mismatch for trade " + i;
		if (trade.status !== "SUCCESS" && trade.status !== "COMMITTED")
			return "unexpected trade status: " + trade.status + " in trade " + i;
		const rows = await db.query("SELECT bounced FROM aa_responses WHERE trigger_unit=?", [unit]);
		if (rows.length && !rows[0].bounced) // if not known yet, we'll later first learn about the trigger, then update its status online
			trade.status = "COMMITTED";
		trade.createdAt = new Date(trade.createdAt);
		trade.updatedAt = new Date(trade.updatedAt);
	}

	// update the affected orders:
	// the taker
	let res = await mongodb.collection('orders').updateOne({ hash: taker_be_order.hash }, {
		$set: {
			status: taker_be_order.status,
			filledAmount: taker_be_order.filledAmount,
			remainingSellAmount: taker_be_order.remainingSellAmount,
		}
	});
	console.error('---- updated taker order ' + taker_be_order.hash, res.matchedCount, res.modifiedCount, res.acknowledged);
	// ... and makers
	for (let i = 0; i < matches.makerOrders.length; i++){ // even if some trades fail, the order status is still updated
		let be_order = matches.makerOrders[i];
		console.error('---- updating order ' + be_order.hash);
		let res = await mongodb.collection('orders').updateOne({ hash: be_order.hash }, {
			$set: {
				status: be_order.status,
				filledAmount: be_order.filledAmount,
				remainingSellAmount: be_order.remainingSellAmount,
			}
		});
		console.error('---- updated order ' + be_order.hash, res.matchedCount, res.modifiedCount, res.acknowledged);
	}

	try {
		await mongodb.collection('trades').insertMany(matches.trades, { ordered: false });
	}
	catch (e) {
		console.log("insert trades failed: " + e);
	}
	eventBus.emit('submitted_trades', { trigger_units: matches.trades.map(trade => trade.hash) });
	addresses.forEach(address => {
		eventBus.emit('refresh_balances', address, 'submitted_trade');
	});
	return null;
}

async function readOrAddOrder(be_order, origin_address) {
	if (be_order.hash !== orders.getOrderHash(be_order.originalOrder))
		return [null, "wrong order hash"];
	let order = await mongodb.collection('orders').findOne({ hash: be_order.hash });
	if (order)
		return [order, null];
	let err = await orders.handleSignedOrder(be_order.originalOrder, origin_address);
	if (err)
		return [null, 'bad user order: ' + err];
	order = await readOrderWithRetries(be_order);
	return order ? [order, null] : [null, "order " + be_order.hash + " not found"];
}

async function readOrderWithRetries(be_order) {
	let count = 0;
	while (true) {
		let order = await mongodb.collection('orders').findOne({ hash: be_order.hash });
		if (order)
			return order;
		count++;
		if (count > 10) {
			console.error("failed to read order " + be_order.hash + " after several retries");
			return null;
		}
		await wait(1000);
	}
}

function wait(timeout) {
	return new Promise(resolve => setTimeout(resolve, timeout));
}

function initLightClient() {
	network.startAcceptingConnections();
	network.startPeerExchange();
	if (conf.light_peers)
		conf.light_peers.forEach(peer => {
			network.findOutboundPeerOrConnect(peer);
		});
}

eventBus.on('connected', ws => {
	network.sendJustsaying(ws, 'custom', { service: 'odex' });
});

eventBus.on('custom_justsaying', async (ws, body) => {
	if (!body)
		return;
	if (body.service === 'odex') {
		assocWsPeers[ws.peer] = ws;
		console.log('added odex peer ' + ws.peer);
		ws.on('close', () => {
			console.log("removing peer " + ws.peer);
			delete assocWsPeers[ws.peer];
		});
		return network.sendJustsaying(ws, 'custom', { last_known_event_hashes: assocLastEventHashes });
	}
	if (!assocWsPeers[ws.peer]) // ignore messages from non-odex peers
		return console.log("ignoring custom_justsaying from non-odex " + ws.peer);
	if (body.signed_event) {
		let objSignedEvent = body.signed_event;
		console.log('received signed event');
		let err = await handleEventUnderLock(ws, objSignedEvent);
		if (!err)
			broadcastMessage(body, ws); // forward it further
		else
			console.log("bad signed event: " + err);
	}
	else if (body.last_known_event_hashes) {
		let arrHashes = Object.values(body.last_known_event_hashes);
		if (arrHashes.length === 0)
			return;
		let arrEvents = await mongodb.collection('events').find({ 'signed_message.event_hash': { $in: arrHashes } }).toArray();
		let arrKnownHashes = arrEvents.map(e => e.signed_message.event_hash);
		let arrUnknownHashes = _.difference(arrHashes, arrKnownHashes);
		arrUnknownHashes.forEach(event_hash => requestEvent(ws, event_hash));
	}
});

eventBus.on('custom_request', async (ws, params, tag) => {
	console.log('custom_request', params);
	if (!params)
		return console.log("ignoring empty custom_request from " + ws.peer);;
	if (!assocWsPeers[ws.peer]) // ignore messages from non-odex peers
		return console.log("ignoring custom_request from non-odex " + ws.peer);
	switch (params.command) {
		case 'init':
			console.log('received init command');
			const response = {};
			response.orders = await mongodb.collection('orders').find({
				status: { $in: ['OPEN', 'PARTAL_FILLED'] }
			}).sort({ createdAt: 1 }).toArray();
			response.trades = await mongodb.collection('trades').find({
				$and: [
					{ status: { $in: ['COMMITTED', 'SUCCESS'] } },
					{ createdAt: { $gt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }, // last 7 days
				]
			}).sort({ createdAt: 1 }).toArray();
			network.sendResponse(ws, tag, response);
			break;
		
		case 'get_event':
			const custom_params = params.params;
			const event_hash = custom_params.event_hash;
			console.log('received get_event ' + event_hash);
			if (!event_hash)
				return network.sendResponse(ws, tag, { error: "no event_hash" });
			const objSignedEvent = await mongodb.collection('events').findOne({ 'signed_message.event_hash': event_hash });
			if (!objSignedEvent)
				return network.sendResponse(ws, tag, { error: "event not found" });
			delete objSignedEvent._id;
			network.sendResponse(ws, tag, { signed_event: objSignedEvent });
			break;
		
		default:
			console.log('unknown command from odex peer: ' + params.command);
	}
});

async function start() {
	mongodb = await mongo.getMongo();
	await mongodb.collection('unhandled_events').createIndex({ 'signed_message.event_hash': 1 }, { unique: true });
	await mongodb.collection('unhandled_events').createIndex({ 'signed_message.prev_event_hash': 1 });
	await mongodb.collection('unhandled_events').createIndex({ 'signed_message.ts': 1 });
	await mongodb.collection('events').createIndex({ 'signed_message.event_hash': 1 }, { unique: true });
	await mongodb.collection('events').createIndex({ 'signed_message.origin': 1 });
//	await mongodb.collection('events').createIndex({ 'signed_message.payload.takerOrder.hash': 1 });
	
	// last event id accross all origins.  The id is not portable.
	const arrAllLastEvents = await mongodb.collection('events').find({'_id': {$type: 'number'}}).sort({ _id: -1 }).limit(1).toArray();
	last_id = arrAllLastEvents.length === 0 ? 0 : arrAllLastEvents[0]._id;
//	console.error('----- last_id', last_id);

	// last event hash from us
	const arrMyLastEvents = await mongodb.collection('events').find({ 'signed_message.origin': operator.getAddress(), '_id': {$type: 'number'} }).sort({ _id: -1 }).limit(1).toArray();
	prev_event_hash = arrMyLastEvents.length === 0 ? null : arrMyLastEvents[0].signed_message.event_hash;
//	console.error('----- prev_event_hash', prev_event_hash);

	// last event hashes of all origins
	const arrLastEventHashes = await mongodb.collection('events').aggregate([{
		$group: {
			_id: '$signed_message.origin',
			last_event_hash: { $last: '$signed_message.event_hash' }
		}
	}]).toArray();
//	console.error('----- arrLastEventHashes', arrLastEventHashes);
	arrLastEventHashes.forEach(row => {
		assocLastEventHashes[row._id] = row.last_event_hash;
	});

	const status = await mongodb.collection('status').findOne();
	if (!status) {
		since = Date.now();
		await mongodb.collection('status').insertOne({ _id: 1, since });
	}
	else
		since = status.since;
	if (!status || !status.initialized) // init the exchange
		setTimeout(initFromPeers, 1000);
	else
		setTimeout(requestUnresolvedEventsFromAllPeers, 1000);
	
	if (conf.bLight)
		network.isStarted() ? initLightClient() : eventBus.once('network_started', initLightClient);
}

exports.createAndBroadcastEvent = createAndBroadcastEvent;
exports.start = start;
