
const ValidationUtils = require('ocore/validation_utils.js');
const constants = require('ocore/constants.js');
const eventBus = require('ocore/event_bus.js');
const objectHash = require('ocore/object_hash.js');
const db = require('ocore/db.js');
const storage = require('ocore/storage.js');
const network = require('ocore/network.js');
const walletGeneral = require('ocore/wallet_general.js');
const conf = require('ocore/conf.js');

const operator = require('./operator.js');
const utils = require('./utils.js');
const signing = require('./signing.js');
const orders = require('./orders.js');
const mongo = require('./mongo.js');

let assocPendingWithdrawals = {};

let assocSymbolByAsset = {};
let assocAssetBySymbol = {};
let assocDecimalsByAsset = {};

function readAAStateVar(aa_address, var_name, cb) {
	if (!cb)
		return new Promise(resolve => readAAStateVar(aa_address, var_name, resolve));
	console.error('----- readAAStateVar', aa_address, var_name);
	readAAStateVars(aa_address, var_name, assocVars => {
		cb(assocVars[var_name]);
	});
}

function readAAStateVars(aa_address, var_prefix, cb) {
	if (!cb)
		return new Promise(resolve => readAAStateVars(aa_address, var_prefix, resolve));
	conf.bLight ? readAAStateVarsLight(aa_address, var_prefix, cb) : readAAStateVarsFull(aa_address, var_prefix, cb);
}

function readAAStateVarsFull(aa_address, var_prefix, cb) {
	storage.readAAStateVars(aa_address, var_prefix, var_prefix, 0, cb);
}

function readAAStateVarsLight(aa_address, var_prefix, cb) {
	requestFromLightVendorWithRetries('light/get_aa_state_vars', { address: aa_address, var_prefix: var_prefix }, function (response) {
		let assocVars = response;
		cb(assocVars);
	});
}

function requestFromLightVendorWithRetries(command, params, cb, count_retries) {
	count_retries = count_retries || 0;
	network.requestFromLightVendor(command, params, (ws, request, response) => {
		if (response.error && Object.keys(response).length === 1 && response.error.startsWith('[internal]')) {
			if (count_retries > 3)
				throw Error("got error after 3 retries: " + response.error);
			return setTimeout(() => requestFromLightVendorWithRetries(command, params, cb, count_retries + 1), 5000);
		}
		cb(response);
	});
}

function getBalances(address, cb) {
//	console.error('--- getBalances received', address);
	let var_prefix = "balance_" + address + "_";
	readAAStateVars(conf.aa_address, var_prefix, async (assocVars) => {
		let balances_by_symbol = { GBYTE: 0 };
		let balances_by_asset = { base: 0 };
		for (let key in assocVars) {
			if (!key.startsWith(var_prefix))
				continue;
			let asset = key.substr(var_prefix.length);
			let symbol = await getSymbolByAsset(asset);
			balances_by_symbol[symbol] = balances_by_asset[asset] = parseInt(assocVars[key]);
		}
		cb(subtractPendingWithdrawals(address, { balances_by_symbol, balances_by_asset }));
	});
}

function getBalance(address, asset, cb) {
//	console.error('--- getBalance received', address, asset);
	getBalances(address, ({ balances_by_asset }) => {
		cb(balances_by_asset[asset] || 0);
	});
/*	const var_name = 'balance_' + address + '_' + (asset || 'base');
	if (conf.bLight)
		return readAAStateVars(var_name, assocVars => {
			let balance = assocVars[var_name];
			cb(balance ? parseInt(balance) : 0);
		});
	storage.readAAStateVar(conf.aa_address, var_name, balance => {
		cb(balance ? parseInt(balance) : 0);
	});*/
}

async function getAuthorizedAddresses(address) {
	const var_prefix = "grant_" + address + "_to_";
	let assocGrantVars = await readAAStateVars(conf.aa_address, var_prefix);
	let arrAuthorizedAddresses = [];
	for (let var_name in assocGrantVars)
		arrAuthorizedAddresses.push(var_name.substr(var_prefix.length));
	return arrAuthorizedAddresses;
}

async function isAuthorized(owner_address, signer_address) {
	const arrAuthorizedAddresses = await getAuthorizedAddresses(owner_address);
	return arrAuthorizedAddresses.includes(signer_address);
}

function subtractPendingWithdrawals(address, {balances_by_symbol, balances_by_asset}) {
	for (let unit in assocPendingWithdrawals) {
		let withdrawalInfo = assocPendingWithdrawals[unit];
		if (withdrawalInfo.address !== address)
			continue;
		if (withdrawalInfo.amount === 'all') {
			console.error("subtracting pending full withdrawal of " + withdrawalInfo.symbol + " from " + address);
			balances_by_symbol[withdrawalInfo.symbol] = 0;
			balances_by_asset[withdrawalInfo.asset] = 0;
			continue;
		}
		if (withdrawalInfo.amount > balances_by_symbol[withdrawalInfo.symbol]) // would be negative, ignore
			continue;
		console.error("subtracting pending withdrawal " + withdrawalInfo.amount + " " + withdrawalInfo.symbol + " from " + address);
		balances_by_symbol[withdrawalInfo.symbol] -= withdrawalInfo.amount;
		balances_by_asset[withdrawalInfo.asset] -= withdrawalInfo.amount;
	}
	console.error('after subtract', balances_by_symbol, balances_by_asset);
	return { balances_by_symbol, balances_by_asset };
}

function resetAssetInfos() {
	assocSymbolByAsset = {};
	assocAssetBySymbol = {};
	assocDecimalsByAsset = {};
}


async function getSymbolByShortLivedAsset(asset, cb){
	if (!cb)
		return new Promise(resolve => getSymbolByShortLivedAsset(asset, resolve));
	for (var i = 0; i < conf.allowed_namers.length; i++) {
		let var_prefix = "a2s_" + asset + "|" + conf.allowed_namers[i].base_aa + "|" + conf.allowed_namers[i].oracle;
		let symbol = await readAAStateVar(conf.short_lived_token_registry_aa_address, var_prefix);
		if (symbol)
			return cb(symbol)
	}
	return cb();
}

async function getShortLivedAssetBySymbol(symbol, cb){
	if (!cb)
		return new Promise(resolve => getShortLivedAssetBySymbol(symbol, resolve));
	for (var i = 0; i <  conf.allowed_namers.length; i++) {
		let var_prefix = "s2a_" + symbol + "|" + conf.allowed_namers[i].base_aa + "|" + conf.allowed_namers[i].oracle;
		let asset = await readAAStateVar(conf.short_lived_token_registry_aa_address, var_prefix);
		if (asset)
			return cb(asset)
	}
	return cb();
}


async function getSymbolByAsset(asset) {
	if (asset === null || asset === 'base')
		return 'GBYTE';
	if (assocSymbolByAsset[asset])
		return assocSymbolByAsset[asset];
	let symbol = await getSymbolByShortLivedAsset(asset) || await readAAStateVar(conf.token_registry_aa_address, 'a2s_' + asset);
	console.error('----- getSymbolByAsset', asset, symbol);
	if (!symbol)
		symbol = asset.replace(/[\/+=]/, '').substr(0, 6);
	assocSymbolByAsset[asset] = symbol;
	return symbol;
}

async function getAssetBySymbol(symbol) {
	if (symbol === 'GBYTE')
		return 'base';
	if (assocAssetBySymbol[symbol])
		return assocAssetBySymbol[symbol];
	let asset = await getShortLivedAssetBySymbol(symbol) || await readAAStateVar(conf.token_registry_aa_address, 's2a_' + symbol);
	console.error('----- getSymbolByAsset', symbol, asset);
	if (asset)
		assocAssetBySymbol[symbol] = asset;
	return asset;
}

async function getDecimalsByAsset(asset) {
	if (asset === null || asset === 'base')
		return 9;
	if (assocDecimalsByAsset[asset] !== undefined)
		return assocDecimalsByAsset[asset];
	let decimals = await getDecimalsByAssetFromTokenRegistry(asset);
	assocDecimalsByAsset[asset] = decimals;
	return decimals;
}

async function getDecimalsByAssetFromTokenRegistry(asset, cb) {
	if (!cb)
		return new Promise(resolve => getDecimalsByAssetFromTokenRegistry(asset, resolve));
	for (var i = 0; i < conf.allowed_namers.length; i++) {
		let var_prefix = "decimals_" + asset + "|" + conf.allowed_namers[i].base_aa + "|" + conf.allowed_namers[i].oracle;
		let decimals = await readAAStateVar(conf.short_lived_token_registry_aa_address, var_prefix);
		if (decimals)
			return cb(parseInt(decimals))
	}

	let desc_hash = await readAAStateVar(conf.token_registry_aa_address, 'current_desc_' + asset);
	if (!desc_hash)
		return cb(0);
	let decimals = await readAAStateVar(conf.token_registry_aa_address, 'decimals_' + desc_hash);
	console.error('------ getDecimalsByAssetFromTokenRegistry', asset, decimals);
	return cb(decimals ? parseInt(decimals) : 0);
}

function checkAssetExists(asset, cb, bRetrying) {
	if (asset === null || asset === 'base' || assocSymbolByAsset[asset])
		return cb(true);
	storage.readAssetInfo(db, asset, objAsset => {
		if (objAsset || !conf.bLight || bRetrying)
			return cb(!!objAsset);
		network.requestHistoryFor([asset], [], () => {
			checkAssetExists(asset, cb, true);
		});
	});
}

function getSymbol(asset, cb) {
	console.error('--- getSymbol received', asset);
	checkAssetExists(asset, async (bExists) => {
		bExists ? cb(null, await getSymbolByAsset(asset)) : cb("asset not found");
	});
}

async function getAsset(symbol, cb) {
	console.error('--- getAsset received', symbol);
	let asset = await getAssetBySymbol(symbol);
	asset ? cb(null, asset) : cb("symbol not found");
}

function getDecimals(asset, cb) {
	console.error('--- getDecimals received', asset);
	checkAssetExists(asset, async (bExists) => {
		bExists ? cb(null, await getDecimalsByAsset(asset)) : cb("asset not found");
	});
}


async function onAAResponse(objAAResponse) {
	delete assocPendingWithdrawals[objAAResponse.trigger_unit];
	let event = objAAResponse.response.responseVars ? objAAResponse.response.responseVars.event : '';
	if (!event && !objAAResponse.bounced)
		throw Error("no event?")
	if (event === 'trade' || objAAResponse.bounced)
		eventBus.emit('exchange_response', objAAResponse); // we do not return and will send balance updates for trade events as well
	if (objAAResponse.bounced) {
		if (objAAResponse.trigger_address !== operator.getAddress()) // failed user-initiated operation
			sendBalancesUpdate(objAAResponse.trigger_unit, 'bounce');
		if (event === 'trade')
			throw Error("bounced trade " + JSON.stringify(objAAResponse, null, '\t'));
		return;
	}
	if (event === 'cancel') { // onchain cancel
		let hash = objAAResponse.response.responseVars.id;
		eventBus.emit('cancel_order', { orderHash: hash, userAddress: objAAResponse.trigger_address });
		return;
	}
	if (event === 'revocation') { // revoke authorization
		let signerAddress = objAAResponse.response.responseVars.address;
		eventBus.emit('revoke', { signerAddress, userAddress: objAAResponse.trigger_address });
		return;
	}
	// deposit or withdrawal or trade
	let arrAddresses = []; // addresses whose balances are affected
	if (objAAResponse.updatedStateVars) {
		let vars = objAAResponse.updatedStateVars[conf.aa_address];
		for (let var_name in vars) {
			let varInfo = vars[var_name];
			if (var_name.startsWith('balance_')) {
				let address = var_name.substr('balance_'.length, 32);
				if (address !== operator.getAddress() && !arrAddresses.includes(address))
					arrAddresses.push(address);
			}
		}
	}
	else { // e.g. light clients don't receive updatedStateVars
		let responseVars = objAAResponse.response.responseVars;
		for (let var_name in responseVars) {
			let address = var_name.split('_')[0];
			if (ValidationUtils.isValidAddress(address) && address !== operator.getAddress() && !arrAddresses.includes(address))
				arrAddresses.push(address);
		}
	}
	if (arrAddresses.length === 0 && !(objAAResponse.trigger_address === operator.getAddress() && ['deposit', 'withdrawal'].includes(event)))
		throw Error("no addresses affected? " + JSON.stringify(objAAResponse));
	arrAddresses.forEach(address => {
		sendBalancesUpdate(address, event);
	});

	// withdrawal by the operator
	if (event === 'withdrawal' && objAAResponse.trigger_address === operator.getAddress())
		eventBus.emit('withdrawal_to_operator');

	// check the trade amount and that the executed orders are marked as filled
	if (event === 'trade' && !objAAResponse.bounced)
		await checkTrade(objAAResponse);
}

async function checkTrade(objAAResponse) {
	let assocAmounts = {};
	let assocExecutedOrders = {};
	let assocAmountsLeft = {};
	let bMatcherIsMe = (objAAResponse.trigger_address === operator.getAddress());
	let responseVars = objAAResponse.response.responseVars;
	for (let var_name in responseVars) {
		if (var_name.startsWith('amount_') && !var_name.startsWith('amount_left_')) {
			const asset = var_name.substr('amount_'.length);
			if (!utils.isValidAsset(asset))
				throw Error("bad asset: " + asset);
			assocAmounts[asset] = responseVars[var_name];
		}
		else if (var_name.startsWith('amount_left_')) {
			const hash = var_name.substr('amount_left_'.length);
			if (!ValidationUtils.isValidBase64(hash, constants.HASH_LENGTH))
				throw Error("bad order hash: " + hash);
			assocAmountsLeft[hash] = responseVars[var_name];
		}
		else if (var_name.startsWith('executed_')) {
			const hash = var_name.substr('executed_'.length);
			if (!ValidationUtils.isValidBase64(hash, constants.HASH_LENGTH))
				throw Error("bad order hash: " + hash);
			assocExecutedOrders[hash] = 1;
		}
	}
	if (Object.keys(assocAmounts).length !== 2)
		throw Error("wrong number of transacted amounts: " + JSON.stringify(assocAmounts));
	if (Object.keys(assocAmountsLeft).length > 1)
		throw Error("wrong number of amounts left: " + JSON.stringify(assocAmountsLeft));
	const count_executed_orders = Object.keys(assocExecutedOrders).length;
	if (count_executed_orders !== 1 && count_executed_orders !== 2)
		throw Error("wrong number of executed orders: " + JSON.stringify(assocExecutedOrders));

	let mongodb = await mongo.getMongo();

	// check the trade amount
	let trade = await mongodb.collection('trades').findOne({ txHash: objAAResponse.trigger_unit });
	if (!trade) {
		if (bMatcherIsMe)
			throw Error("own trade not found: " + objAAResponse.trigger_unit);
		console.log("another matcher's trade " + objAAResponse.trigger_unit + " not found");
	}
	else {
		let amount = assocAmounts[trade.baseToken];
		if (!amount)
			throw Error("nothing transacted in base token");
		if (amount !== trade.amount) {
			if (0 && Math.abs(amount - trade.amount) === 1) {
				console.error("trade amount mismatch by 1 in " + objAAResponse.trigger_unit + ": AA says " + amount + ", db says " + trade.amount + " likely due to rounding error, will update the db");
				await mongodb.collection('trades').updateOne({ txHash: objAAResponse.trigger_unit }, { $set: { amount: amount } });
			}
			else
				throw Error("trade amount mismatch in " + objAAResponse.trigger_unit + ": AA says " + amount + ", db says " + trade.amount);
		}
		let quoteAmount = assocAmounts[trade.quoteToken];
		if (!quoteAmount)
			throw Error("nothing transacted in quote token");
		if (quoteAmount !== trade.quoteAmount)
			throw Error("trade quote amount mismatch in " + objAAResponse.trigger_unit + ": AA says " + quoteAmount + ", db says " + trade.quoteAmount);
	}

	// check that all executed orders are filled
	for (let hash in assocExecutedOrders) {
		let order = await mongodb.collection('orders').findOne({ hash });
		if (!order) {
			if (bMatcherIsMe)
				throw Error("own order not found by hash " + hash);
			console.log("another matcher's order " + hash + " not found");
			continue;
		}
		if (order.status !== 'FILLED') {
			if (['CANCELLED', 'AUTO_CANCELLED'].includes(order.status) && order.remainingSellAmount === 0)
				console.log("executed order " + hash + " appears to be filled but has status " + order.status);
			else {
				if (!bMatcherIsMe)
					return console.log("another matcher's executed order " + hash + " is " + order.status + " in the db, filled " + order.filledAmount + " of " + order.amount + ", probably not synced yet, will abort other checks");
				throw Error("executed order " + hash + " is " + order.status + " in the db, filled " + order.filledAmount + " of " + order.amount);
			}
		}
	}

	// check that amounts left are >= than in the db
	for (let hash in assocAmountsLeft) {
		let order = await mongodb.collection('orders').findOne({ hash });
		if (!order) {
			if (bMatcherIsMe)
				throw Error("own order not found by hash " + hash);
			console.log("another matcher's order " + hash + " not found");
			continue;
		}
		if (order.remainingSellAmount > assocAmountsLeft[hash]) {
			if (!bMatcherIsMe)
				return console.log("amount left on another matcher's order " + hash + " is too large in db after trade " + objAAResponse.trigger_unit + ": AA says " + assocAmountsLeft[hash] + ", db says " + order.remainingSellAmount + ", probably not synced yet, will abort other checks");
			throw Error("amount left on order " + hash + " is too large in db after trade " + objAAResponse.trigger_unit + ": AA says " + assocAmountsLeft[hash] + ", db says " + order.remainingSellAmount);
		}
		if (trade) {
			let role;
			if (trade.takerOrderHash === hash)
				role = 'taker';
			else if (trade.makerOrderHash === hash)
				role = 'maker';
			else
				throw Error("amounts left on order " + hash + " which is neither take nor maker in trade " + objAAResponse.trigger_unit);
			let db_amount_left = trade[role === 'taker' ? 'remainingTakerSellAmount' : 'remainingMakerSellAmount'];
			if (db_amount_left !== assocAmountsLeft[hash])
				throw Error("amount left on order " + hash + " mismatch after trade " + objAAResponse.trigger_unit + ": AA says " + assocAmountsLeft[hash] + ", db says " + db_amount_left);
		}
		/*let events = await mongodb.collection('events').find({ "signed_message.payload.takerOrder.hash": trade.takerOrderHash }).toArray();
		if (!events || events.length === 0) {
			if (objAAResponse.trigger_address === operator.getAddress())
				throw Error("own event not found by takerOrderHash " + trade.takerOrderHash);
			console.log("another matcher's event with taker " + trade.takerOrderHash + " not found");
			continue;
		}
		// we can have several events if only part of the trades were executed after the first attempt and the rest failed due to lack of funds, then we retried and the second attempt generated a new event
		let event = events[0];
		order = null;
		if (event.signed_message.payload.takerOrder.hash === hash) { // our order is a taker
			order = event.signed_message.payload.takerOrder;
			if (events.length > 1 || event.signed_message.payload.makerOrders.length > 1) // our order is a taker that matched several makers and its final remaining balance is the result of several matches
				continue;
			// there could be other makers and the corresponding trades are not sent yet (e.g. due to lack of funds)
			continue;
		}
		if (!order) { // search our order among makers
			events_loop: for (let j = 0; j < events.length; j++) {
				const makerOrders = events[j].signed_message.payload.makerOrders;
				for (let i = 0; i < makerOrders.length; i++) {
					if (makerOrders[i].hash === hash) {
						order = makerOrders[i];
						break events_loop;
					}
				}
			}
			if (!order)
				throw Error("order " + hash + " not found in event " + event._id);
		}
		if (order.remainingSellAmount !== assocAmountsLeft[hash]) {
			if (0 && Math.abs(order.remainingSellAmount - assocAmountsLeft[hash]) === 1)
				console.error(("amount left on order " + hash + " mismatch by 1 after trade " + objAAResponse.trigger_unit + ": AA says " + assocAmountsLeft[hash] + ", db says " + order.remainingSellAmount));
			else
				throw Error("amount left on order " + hash + " mismatch after trade " + objAAResponse.trigger_unit + ": AA says " + assocAmountsLeft[hash] + ", db says " + order.remainingSellAmount);
		}*/
	}
}

// some events might be missed if the daemon crashes
async function updateTradeStatuses() {
	if (conf.bLight && !network.isStarted()) // we need the network to read the balances in AA and send balance updates
		return eventBus.once('network_started', updateTradeStatuses);
	let mongodb = await mongo.getMongo();
	let trades = await mongodb.collection('trades').find({ status: 'SUCCESS' }).toArray();
	console.error(trades.length + " uncommitted trades");
	if (trades.length === 0)
		return;
	let arrUnits = trades.map(trade => trade.txHash);
	let rows = await db.query("SELECT mci, trigger_address, aa_address, trigger_unit, bounced, response_unit, response, creation_date FROM aa_responses WHERE trigger_unit IN(" + arrUnits.map(db.escape).join(', ') + ") ORDER BY " + (conf.storage === 'sqlite' ? 'rowid' : 'mci'));
	console.error(rows.length + " unhandled AA responses");
	rows.forEach(row => {
		objectHash.cleanNulls(row);
		row.response = JSON.parse(row.response);
		let objAAResponse = row;
		onAAResponse(objAAResponse);
	});
}

// look for trigger units sent to the AA
async function onSavedUnit(objJoint) {
	let objUnit = objJoint.unit;
	if (!objUnit.messages) // final-bad
		return;
	let objBaseMessage = objUnit.messages.find(message => message.app === 'payment' && !message.payload.asset);
	if (!objBaseMessage.payload.outputs.find(output => output.address === conf.aa_address && output.amount >= constants.MIN_BYTES_BOUNCE_FEE))
		return;
	let objDataMessage = objUnit.messages.find(message => message.app === 'data');
	let data = objDataMessage ? objDataMessage.payload : null;
	let address = objUnit.authors[0].address;
	if (address === conf.aa_address /*|| address === operator.getAddress()*/) // sent by AA or operator
		return;
	// deposits
	if (!data || ValidationUtils.isValidAddress(data.to)) {
		if (data && data.to)
			address = data.to;
		sendBalancesUpdate(address, 'pending_deposit');
	}
	// withdrawals
	else if (data && data.withdraw && (data.amount > 0 || data.amount === 'all') && utils.isValidAsset(data.asset)) {
		let withdrawn_symbol = await getSymbolByAsset(data.asset);
		getBalances(address, ({ balances_by_symbol, balances_by_asset }) => {
			let amount = (data.amount === 'all') ? balances_by_asset[data.asset] : data.amount;
			balances_by_symbol[withdrawn_symbol] -= amount;
			balances_by_asset[data.asset] -= amount;
			if (balances_by_symbol[withdrawn_symbol] < 0) // it'll fail
				return console.error("received a withdrawal from " + address + " that will fail");
			assocPendingWithdrawals[objUnit.unit] = { address, asset: data.asset, symbol: withdrawn_symbol, amount: data.amount };
			eventBus.emit('balances_update', { address, balances_by_symbol, balances_by_asset, event: 'pending_withdrawal' });
		});
	}
	// cancels
	else if (data && data.cancel && data.order) {
		signing.validateSignedMessage(data.order, err => {
			if (err)
				return console.log("bad cancel: " + err);
			if (order.signed_message.address !== address)
				return console.log("cancelling of another's order");
			let hash = orders.getOrderHash(order);
			eventBus.emit('cancel_order', { orderHash: hash, userAddress: address });
		});
	}
	// revokes
	else if (data && data.revoke && ValidationUtils.isValidAddress(data.address))
		eventBus.emit('revoke', { signerAddress: data.address, userAddress: address });
	// trade submitted by another matcher
	else if (data && data.order1 && data.order2 && address !== operator.getAddress() && !orders.getOrderError(data.order1.signed_message) && !orders.getOrderError(data.order2.signed_message)) {
		
	}
}

function sendBalancesUpdate(address, event) {
	getBalances(address, ({balances_by_symbol, balances_by_asset}) => {
		eventBus.emit('balances_update', { address, balances_by_symbol, balances_by_asset, event });
	});
}

eventBus.on('refresh_balances', sendBalancesUpdate);

function startWatching() {
	if (conf.bLight)
		walletGeneral.addWatchedAddress(conf.aa_address, () => { });
	eventBus.on('aa_response_from_aa-' + conf.aa_address, onAAResponse);
	eventBus.on('saved_unit', onSavedUnit);
	updateTradeStatuses();
	setInterval(resetAssetInfos, 3600 * 1000);
}

exports.getBalance = getBalance;
exports.getBalances = getBalances;
exports.getSymbol = getSymbol;
exports.getAsset = getAsset;
exports.getDecimals = getDecimals;
exports.getAuthorizedAddresses = getAuthorizedAddresses;
exports.isAuthorized = isAuthorized;
exports.startWatching = startWatching;

