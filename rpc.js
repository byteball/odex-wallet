
const rpcify = require('rpcify');
const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');

const operator = require('./operator.js');
const orders = require('./orders.js');
const cancels = require('./cancels.js');
const trade_queue = require('./trade_queue.js');
const replication = require('./replication.js');
const dagState = require('./dag_state.js');


function getOperatorAddress(dummy, cb) {
	console.error('--- getOperatorAddress received');
	cb(operator.getAddress());
}

function getFees(dummy, cb) {
	console.error('--- getFees received');
	cb(conf.matcher_fee, conf.affiliate_fee);
}

function addOrder(objSignedMessage, cb){
	console.error('--- addOrder received', objSignedMessage);
	orders.handleSignedOrder(objSignedMessage, operator.getAddress(), (err, hash) => {
		if (err)
			return cb(err);
		replication.createAndBroadcastEvent('order', objSignedMessage);
		cb(null, hash);
	});
}

function cancelOrder(objSignedMessage, cb){
	console.error('--- cancelOrder received', objSignedMessage);
	cancels.handleSignedCancel(objSignedMessage, null, err => {
		if (err)
			return cb(err);
		replication.createAndBroadcastEvent('cancel', objSignedMessage);
		cb(null, 'done');
	});
}


async function getAuthorizedAddresses(address, cb) {
	const arrAuthorizedAddresses = await dagState.getAuthorizedAddresses(address);
	cb(arrAuthorizedAddresses);
}

function start() {
	// start listening on RPC port
	rpcify.listen(conf.rpcPort, '127.0.0.1');

	// expose some functions via RPC
//	rpcify.expose(headlessWallet.sendMultiPayment);
	rpcify.expose(dagState.getBalance, true);
	rpcify.expose(dagState.getBalances, true);
	rpcify.expose(getOperatorAddress, true);
	rpcify.expose(getFees, true);
	rpcify.expose(dagState.getSymbol);
	rpcify.expose(dagState.getAsset);
	rpcify.expose(dagState.getDecimals);
	rpcify.expose(getAuthorizedAddresses, true);
//	rpcify.expose(verifySignature);
//	rpcify.expose(verifyCancelSignature);
	rpcify.expose(addOrder);
	rpcify.expose(cancelOrder);
	rpcify.expose(trade_queue.executeTrade);

	rpcify.exposeEvent(eventBus, "submitted_trades");
	rpcify.exposeEvent(eventBus, "exchange_response");
//	rpcify.exposeEvent(eventBus, "exchange_error");
	rpcify.exposeEvent(eventBus, "new_order");
	rpcify.exposeEvent(eventBus, "cancel_order");
	rpcify.exposeEvent(eventBus, "revoke");
	rpcify.exposeEvent(eventBus, "balances_update");
	rpcify.exposeEvent(eventBus, "loggedin");

}

exports.start = start;
