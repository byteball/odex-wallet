const headlessWallet = require('headless-obyte');
const ValidationUtils = require('ocore/validation_utils.js');
const constants = require('ocore/constants.js');
const eventBus = require('ocore/event_bus.js');
const device = require('ocore/device.js');

const operator = require('./operator.js');
const signing = require('./signing.js');
const orders = require('./orders.js');
const cancels = require('./cancels.js');
const userSignedMessages = require('./user_signed_messages.js');
const replication = require('./replication.js');

let assocSessionIdByDeviceAddress = {};
let assocAddressByOrderHash = {};


function sendGreeting(from_address) {
	device.sendMessageToDevice(from_address, 'text', 'To log in to the DEX, please let me know your address (click ... and "Insert my address")\n\nPlease use a single-address wallet.');
}

function onPaired(from_address, pairing_secret) {
	// login
	if (ValidationUtils.isValidHexadecimal(pairing_secret, 40)) {
		let sessionId = pairing_secret;
		assocSessionIdByDeviceAddress[from_address] = sessionId;
		return sendGreeting(from_address);
	}
	let sendResponse = (text) => device.sendMessageToDevice(from_address, 'text', text);
	// cancel order
	if (pairing_secret.startsWith('cancel-')) {
		let [, hash, address] = pairing_secret.split('-');
		if (!ValidationUtils.isValidBase64(hash, constants.HASH_LENGTH) || !ValidationUtils.isValidAddress(address))
			return sendResponse('Welcome to DEX!');
		assocAddressByOrderHash[hash] = address;
		return sendResponse(`Please sign the cancel command: [message](sign-message-request-network-aware:${cancels.getCancelOrderPrefix() + hash}).`);
	}
	// new order
	let json = Buffer.from(pairing_secret, 'base64').toString('utf8');
	console.log(json);
	try{
		var order_request = JSON.parse(json);
	}
	catch(e){
		return sendResponse('Welcome to DEX!');
	}
	
	if (order_request.price > 0)
		order_request.price = orders.getPriceInAllowedPrecision(order_request);
	let err = orders.getOrderError(order_request, operator.getAddress());
	if (err)
		return sendResponse(err);
		
	let objOrderMessage = {
		sell_asset: order_request.sell_asset,
		buy_asset: order_request.buy_asset,
		sell_amount: order_request.sell_amount,
		price: order_request.price,
		aa: order_request.aa,
		matcher: order_request.matcher,
		address: order_request.address,
		matcher_fee_asset: order_request.matcher_fee_asset,
		matcher_fee: order_request.matcher_fee,
	};
	if (order_request.affiliate && order_request.affiliate_fee && order_request.affiliate_fee_asset) {
		objOrderMessage.affiliate = order_request.affiliate;
		objOrderMessage.affiliate_fee = order_request.affiliate_fee;
		objOrderMessage.affiliate_fee_asset = order_request.affiliate_fee_asset;
	}
	if (order_request.nonce)
		objOrderMessage.nonce = order_request.nonce;
	if (order_request.expiry_ts)
		objOrderMessage.expiry_ts = order_request.expiry_ts;
	let b64OrderMessage = Buffer.from(JSON.stringify(objOrderMessage), 'utf8').toString('base64');
	sendResponse(`Please sign the order: [message](sign-message-request-network-aware:${b64OrderMessage}).`);
}

function getSignedText(address) {
	return "I own the address " + address;
}


function respond(from_address, text) {
	let sendResponse = (msg) => device.sendMessageToDevice(from_address, 'text', msg);
	if (ValidationUtils.isValidAddress(text)) {
		let sessionId = assocSessionIdByDeviceAddress[from_address];
		if (!sessionId)
			return sendResponse(`Session expired, please go back to the website and try to log in again.`);
		let signed_text = getSignedText(text);
		return sendResponse(`Thanks, now please prove ownership of your address by signing a message: [message](sign-message-request:${signed_text}).`);
	}

	let arrSignedMessageMatches = text.match(/\(signed-message:(.+?)\)/);
	if (!arrSignedMessageMatches)
		return sendGreeting(from_address);
	
	let signedMessageBase64 = arrSignedMessageMatches[1];
	let signedMessageJson = Buffer.from(signedMessageBase64, 'base64').toString('utf8');
	try{
		var objSignedMessage = JSON.parse(signedMessageJson);
		var address = objSignedMessage.authors[0].address;  // not used but might throw if the object's structure is invalid
	}
	catch(e){
		return;
	}
	switch (userSignedMessages.getSignedMessageType(objSignedMessage.signed_message)) {
		case 'login':
			handleSignedLogin(objSignedMessage, from_address, err => {
				if (err)
					return sendResponse(err);
				sendResponse(`You are logged in, please get back to the website.`);
			});
			break;
		case 'order':
			orders.handleSignedOrder(objSignedMessage, operator.getAddress(), err => {
				if (err)
					return sendResponse(err);
				sendResponse(`Order submitted, please get back to the website.`);
				replication.createAndBroadcastEvent('order', objSignedMessage);
			});
			break;
		case 'cancel':
			cancels.handleSignedCancel(objSignedMessage, assocAddressByOrderHash, err => {
				if (err)
					return sendResponse(err);
				sendResponse(`Cancel command submitted, please get back to the website.`);
				replication.createAndBroadcastEvent('cancel', objSignedMessage);
			});
			break;
	}
}

function handleSignedLogin(objSignedMessage, from_address, handleResult) {
	if (!handleResult)
		return new Promise(function(resolve){
			handleSignedLogin(objSignedMessage, origin_address, resolve);
		});
	let sessionId = assocSessionIdByDeviceAddress[from_address];
	if (!sessionId)
		return handleResult(`Session expired, please go back to the website and try to log in again.`);
	signing.validateSignedMessage(objSignedMessage, err => {
		if (err)
			return handleResult(err);
		var address = objSignedMessage.authors[0].address;
		let signed_text = getSignedText(address);
		if (objSignedMessage.signed_message !== signed_text)
			return handleResult("You signed a wrong message: " + objSignedMessage.signed_message + ", expected: " + signed_text);
	
		// all is good, address proven
		console.error('loggedin', sessionId, address);
		eventBus.emit('loggedin', { sessionId, address });
		//	delete assocSessionIdByDeviceAddress[from_address];

		handleResult();
	});
}


function start() {
	headlessWallet.setupChatEventHandlers();
	eventBus.on('text', (from_address, text) => {
		respond(from_address, text.trim());
	});
	eventBus.on('paired', onPaired);
}

exports.start = start;
