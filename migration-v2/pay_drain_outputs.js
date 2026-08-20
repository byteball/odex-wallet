/*jslint node: true */
"use strict";
// Pays out the recipients recorded in a drain_outputs_by_asset.json plan (the payout
// map drain_and_repay.js saves before draining/withdrawing), in case that script's own
// final payout step (see the sendMultiPayment call near the end of drain_and_repay.js)
// never ran or needs to be redone from the saved plan.
//
// Usage: node pay_drain_outputs.js [path-to-outputs-file]  (defaults to ./drain_outputs_by_asset.json)
//
// By default this is a DRY RUN (only prints what it would send).
// Set env var CONFIRM_PAYOUT=1 to actually sign and broadcast the payout.

const fs = require('fs');
const network = require('ocore/network.js');
const lightWallet = require('ocore/light_wallet.js');
const headlessWallet = require('headless-obyte');
const operator = require('aabot/operator.js');

const OUTPUTS_FILE = process.argv[2] || './drain_outputs_by_asset.json';
const bDryRun = process.env.CONFIRM_PAYOUT !== '1';


function wait(mc) {
	return new Promise(resolve => setTimeout(resolve, mc));
}

function sendMultiPayment(opts) {
	return new Promise((resolve, reject) => {
		headlessWallet.sendMultiPayment(opts, (err, unit) => err ? reject(Error(err)) : resolve(unit));
	});
}

async function main() {
	const outputsByAsset = JSON.parse(fs.readFileSync(OUTPUTS_FILE, 'utf8'));
	const assets = Object.keys(outputsByAsset);
	if (assets.length === 0) {
		console.error(`${OUTPUTS_FILE} has no assets to pay out`);
		return process.exit(0);
	}
	console.error(`would pay ${assets.length} assets`);

	await operator.start();
	network.start();
	await lightWallet.waitUntilFirstHistoryReceived();
	await network.requestHistoryFor(assets);
	await wait(5000);
	const payer_address = operator.getAddress();
	console.error((bDryRun ? '[DRY RUN] ' : '') + 'operator address ' + payer_address);

	for (const asset of assets) {
		const owners = outputsByAsset[asset];
		const owners_total = owners.reduce((sum, o) => sum + o.amount, 0);
		console.error(`${bDryRun ? 'would pay' : 'paying'} ${owners_total} of ${asset} to ${owners.length} owner(s)`);
	}

	if (bDryRun) {
		console.error('dry run only, set CONFIRM_PAYOUT=1 to actually sign and broadcast the payout');
		return process.exit(0);
	}

	const unit = await sendMultiPayment({
		outputs_by_asset: outputsByAsset,
		paying_addresses: [payer_address], change_address: payer_address,
		spend_unconfirmed: 'all',
	});
	console.error(`repaid all owners of all assets in a single unit ${unit}`);
	process.exit(0);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
