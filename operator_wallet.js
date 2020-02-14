const constants = require('ocore/constants.js');
const balances = require('ocore/balances.js');
const objectHash = require('ocore/object_hash.js');
const headlessWallet = require('headless-obyte');
const conf = require('ocore/conf.js');
const notifications = require('./notifications.js');

const operator = require('./operator.js');
const dagState = require('./dag_state.js');

async function withdraw(asset, amount) {
	let message = {
		app: 'data',
		payload_location: 'inline',
		payload: {
			withdraw: 1,
			asset: asset,
			amount: amount,
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
	try {
		let { unit } = await headlessWallet.sendMultiPayment(opts);
		console.log("sent withdrawal request, unit " + unit);
	}
	catch (e) {
		console.error("failed to send withdrawal request: " + e);
	}
}

function checkBalance(onDone) {
	if (!onDone)
		return new Promise(resolve => checkBalance(resolve));
	balances.readOutputsBalance(operator.getAddress(), assocBalances => {
		const balance = assocBalances.base.stable + assocBalances.base.pending;
		if (balance > conf.MIN_BALANCE_FOR_REFILL) {
			console.log("sufficient balance: " + balance);
			return onDone(true);
		}
		dagState.getBalance(operator.getAddress(), 'base', async (exchange_balance) => {
			if (exchange_balance < conf.MIN_BALANCE_FOR_NOTIFICATION)
				notifications.notifyAdmin('low balance', "Operator balance is too low, wallet: " + balance + ", on the exchange: " + exchange_balance);
			if (exchange_balance < 50000) {
				console.log("the balance on the exchange is too small (" + exchange_balance + "), will not withdraw");
				return onDone(false);
			}
			console.log("will withdraw " + exchange_balance + " from the exchange to refill the operator wallet");
			await withdraw('base', 'all');
			onDone(true);
		});
	});
}

async function start() {
	let bSufficient = await checkBalance();
	// we might see insufficient balance because we are not synced yet and don't see a recent topup yet
//	if (!bSufficient)
//		throw Error("not sufficient operator balance");
	setInterval(checkBalance, 600*1000);
}

exports.checkBalance = checkBalance;
exports.start = start;
