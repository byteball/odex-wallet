const crypto = require('crypto');
const constants = require('ocore/constants.js');
const ValidationUtils = require('ocore/validation_utils.js');
const formulaCommon = require('ocore/formula/common.js');
const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');
const signing = require('./signing.js');
const dagState = require('./dag_state.js');
const utils = require('./utils.js');
const operator = require('./operator.js');
const mongo = require('./mongo.js');

let arrQuoteAssets;

async function getQuoteAssets() {
	if (arrQuoteAssets)
		return arrQuoteAssets;
	let mongodb = await mongo.getMongo();
	let tokens = await mongodb.collection('tokens').find({ quote: true }, { asset: 1 }).sort({ rank: -1 }).toArray();
	arrQuoteAssets = tokens.map(token => token.asset);
	console.log('quote assets:', arrQuoteAssets);
	return arrQuoteAssets;
}

function getOrderError(order_data, origin_address) {
	if (order_data.matcher !== origin_address && order_data.affiliate !== origin_address)
		return "Origin is neither matcher nor affiliate";
	
	if (order_data.aa !== conf.aa_address)
		return "wrong AA";
	if (ValidationUtils.hasFieldsExcept(order_data, ['aa', 'matcher', 'matcher_fee', 'affiliate', 'affiliate_fee', 'matcher_fee_asset', 'affiliate_fee_asset', 'sell_asset', 'buy_asset', 'sell_amount', 'address', 'price', 'nonce', 'expiry_ts']))
		return "foreign fields in order";
	
	if (!utils.isValidAsset(order_data.sell_asset))
		return 'invalid sell_asset';
	if (!utils.isValidAsset(order_data.buy_asset))
		return 'invalid buy_asset';
	if (order_data.sell_asset === order_data.buy_asset)
		return 'same asset';
	if (!utils.isValidAsset(order_data.matcher_fee_asset))
		return 'invalid matcher_fee_asset';
	if (order_data.affiliate_fee_asset && !utils.isValidAsset(order_data.affiliate_fee_asset))
		return 'invalid affiliate_fee_asset';
	
	if (!ValidationUtils.isValidAddress(order_data.address))
		return 'invalid address';
	if (!ValidationUtils.isValidAddress(order_data.matcher))
		return 'invalid matcher address';
	if (order_data.affiliate && !ValidationUtils.isValidAddress(order_data.affiliate))
		return 'invalid affiliate address';
	
	if (!ValidationUtils.isPositiveInteger(order_data.sell_amount))
		return 'invalid sell_amount';
	if (!ValidationUtils.isPositiveInteger(order_data.matcher_fee))
		return 'invalid matcher_fee: ' + order_data.matcher_fee;
	if ('affiliate_fee' in order_data && !ValidationUtils.isPositiveInteger(order_data.affiliate_fee))
		return 'invalid affiliate_fee';
	if (typeof order_data.price !== 'number' || order_data.price <= 0)
		return 'invalid price';
	if (getPriceInAllowedPrecision(order_data) !== order_data.price)
		return 'excessive precision';
	if ('expiry_ts' in order_data && (!ValidationUtils.isPositiveInteger(order_data.expiry_ts) || order_data.expiry_ts < Date.now()/1000))
		return 'invalid expiry_ts';
	if ('nonce' in order_data) {
		if (!['string', 'number'].includes(typeof order_data.nonce))
			return 'invalid nonce';
		if (order_data.nonce.length > 16)
			return 'nonce is too long';
	}
	let expected_fee;
	const bMatcherIsMe = order_data.matcher === operator.getAddress();
	let matcher_fee =  bMatcherIsMe ? conf.matcher_fee : conf.matcher_fee_max;
	if (order_data.sell_asset === order_data.matcher_fee_asset)
		expected_fee = Math.ceil(order_data.sell_amount * matcher_fee);
	else if (order_data.buy_asset === order_data.matcher_fee_asset)
		expected_fee = Math.ceil(order_data.sell_amount * order_data.price * matcher_fee);
	else
		return "matcher fee paid in a 3rd asset: " + order_data.matcher_fee_asset;
	if (bMatcherIsMe && order_data.matcher_fee < expected_fee)
		return "matcher fee " + order_data.matcher_fee + " is less than expected " + expected_fee;
	if (!bMatcherIsMe && order_data.matcher_fee > expected_fee)
		return "matcher fee is higher than max limit";

	if (order_data.affiliate === operator.getAddress()) { // check the affiliate fees
		if (order_data.sell_asset === order_data.affiliate_fee_asset)
			expected_fee = Math.ceil(order_data.sell_amount * conf.affiliate_fee);
		else if (order_data.buy_asset === order_data.affiliate_fee_asset)
			expected_fee = Math.ceil(order_data.sell_amount * order_data.price * conf.affiliate_fee);
		else
			return "affiliate fee paid in a 3rd asset: " + order_data.affiliate_fee_asset;
		if (order_data.affiliate_fee < expected_fee)
			return "affiliate fee is less than expected " + expected_fee;
	}
	return null;
}

function dropExcessivePrecision(price) {
	let strPrice = price.toPrecision(conf.MAX_PRICE_PRECISION);
	return parseFloat(strPrice);
}

function getFirstAsset(sell_asset, buy_asset) {
	if (sell_asset === 'base')
		return sell_asset;
	if (buy_asset === 'base')
		return buy_asset;
	return (sell_asset < buy_asset) ? sell_asset : buy_asset;
}

function getPriceInAllowedPrecision(order_data) {
	const first_asset = getFirstAsset(order_data.sell_asset, order_data.buy_asset);
	if (first_asset === order_data.sell_asset)
		return dropExcessivePrecision(order_data.price);
	else
		return 1 / dropExcessivePrecision(1 / order_data.price);
}

async function getBackendOrder(order) {
	const order_data = order.signed_message;
	const [base_asset, quote_asset] = await getPair(order_data.sell_asset, order_data.buy_asset);
	const side = (order_data.sell_asset === base_asset) ? 'SELL' : 'BUY';
	let buy_amount = Math.round(order_data.price * order_data.sell_amount);
	let price = dropExcessivePrecision((side === 'SELL') ? order_data.price : 1 / order_data.price);
	let amount = (side === 'SELL') ? order_data.sell_amount : buy_amount;

//	let strPrice = price.toPrecision(8); // drop the excessive precision
//	price = parseFloat(strPrice);
	
	return {
		hash: getOrderHash(order),
		amount,
		userAddress: order_data.address,
		matcherAddress: order_data.matcher,
		price,
		baseToken: base_asset,
		quoteToken: quote_asset,
		side,
		originalOrder: order
	};
}

// returns [base, quote] pair
async function getPair(asset1, asset2) {
	if (asset2 === asset1)
		throw Error("same token " + asset1);
	let arrQuoteAssets = await getQuoteAssets();
	let index1 = arrQuoteAssets.indexOf(asset1);
	let index2 = arrQuoteAssets.indexOf(asset2);
	if (index1 < 0 && index2 < 0)
		throw Error("none of the tokens is quote token: " + asset1 + ", " + asset2);
	if (index2 < 0)
		return [asset2, asset1];
	if (index1 < 0)
		return [asset1, asset2];
	return (index1 > index2) ? [asset1, asset2] : [asset2, asset1];
}

function getOrderHash(order) {
	const order_data = order.signed_message;
	let str = order_data.address + order_data.sell_asset + order_data.buy_asset + order_data.sell_amount + formulaCommon.toOscriptPrecision(order_data.price) + (order_data.nonce || '') + (order.last_ball_unit || '-');
	return crypto.createHash("sha256").update(str, "utf8").digest("base64");
}


function handleSignedOrder(objSignedMessage, origin_address, handleResult) {
	if (!handleResult)
		return new Promise(function(resolve){
			handleSignedOrder(objSignedMessage, origin_address, resolve);
		});
	signing.validateSignedMessage(objSignedMessage, async (err) => {
		if (err)
			return handleResult(err);
		var address = objSignedMessage.authors[0].address;
		let objOrderMessage = objSignedMessage.signed_message;
		if (objOrderMessage.address !== address && !await dagState.isAuthorized(objOrderMessage.address, address))
			return handleResult(`You signed with a wrong address, please make sure you are in the wallet ${objOrderMessage.address}.`);
		err = getOrderError(objOrderMessage, origin_address);
		if (err) {
			console.error("bad order: " + err + "\norder:\n" + JSON.stringify(objOrderMessage, null, '\t'));
			return handleResult(err);
		}
		// if the definition changed and the signature is not network-aware, it has to use the old definition, otherwise its hash won't match the address
	//	if (!ValidationUtils.isValidBase64(objSignedMessage.last_ball_unit, constants.HASH_LENGTH))
	//		return handleResult('invalid last_ball_unit');
		let backendOrder = await getBackendOrder(objSignedMessage);
		eventBus.emit('new_order', backendOrder);
		console.error('----- new_order', objSignedMessage);
		handleResult(null, backendOrder.hash);
	});
}

function ordersAreEqual(be_order, order) {
	return (
		be_order.hash === order.hash
		&& be_order.amount === order.amount
		&& be_order.userAddress === order.userAddress
		&& be_order.matcherAddress === order.matcherAddress
		&& be_order.price === order.price
		&& be_order.baseToken === order.baseToken
		&& be_order.quoteToken === order.quoteToken
		&& be_order.side === order.side
	);
}

/*
function verifySignature(order, cb) {
	const order_data = order.signed_message;
	let err = getOrderError(order_data, operator.getAddress());
	if (err)
		return cb(err);
	if (!ValidationUtils.isValidBase64(order.last_ball_unit, constants.HASH_LENGTH))
		return cb('invalid last_ball_unit');
	signing.validateSignedMessage(order, err => {
		if (err)
			return cb(err);
		let id = getOrderHash(order);
		cb(null, id);
	});
}
*/

exports.getOrderError = getOrderError;
exports.getPriceInAllowedPrecision = getPriceInAllowedPrecision;
exports.getBackendOrder = getBackendOrder;
exports.getOrderHash = getOrderHash;
exports.handleSignedOrder = handleSignedOrder;
exports.ordersAreEqual = ordersAreEqual;
