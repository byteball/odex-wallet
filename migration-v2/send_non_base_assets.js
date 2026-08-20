/*jslint node: true */
"use strict";
// One-off remediation script: reads the internal `balance_<address>_<asset>` state
// vars of the live DEX AA and pays every owner's non-base asset balance directly to
// their address, from the operator's own wallet. This does NOT go through the AA's
// own withdraw() message, because withdraw() only lets the owner (or an address they
// explicitly granted) trigger a payout to themselves - the operator has no general
// authority to move other users' recorded balances out of the AA.
//
// By default this is a DRY RUN: it only prints what it would send.
// Set env var CONFIRM_DRAIN=1 to actually broadcast the payments.

const conf = require('ocore/conf.js');
const network = require('ocore/network.js');
const headlessWallet = require('headless-obyte');
const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');

const AA_ADDRESS = conf.aa_address; // FVRZTCFXIDQ3EYRGQSLE5AMWUQF4PRYJ
const BALANCE_PREFIX = 'balance_';
const ADDRESS_LENGTH = 32;
const bDryRun = process.env.CONFIRM_DRAIN !== '1';

function sendMultiPayment(opts) {
	return new Promise((resolve, reject) => {
		headlessWallet.sendMultiPayment(opts, (err, unit) => err ? reject(Error(err)) : resolve(unit));
	});
}

// group every positive non-base `balance_<address>_<asset>` var by asset
async function getOutputsByAsset() {
	const assocVars = await dag.readAAStateVars(AA_ADDRESS, BALANCE_PREFIX);
	console.error(`read ${Object.keys(assocVars).length} vars from ${AA_ADDRESS}`);
	const outputsByAsset = {};
	for (const key in assocVars) {
		const address = key.slice(BALANCE_PREFIX.length, BALANCE_PREFIX.length + ADDRESS_LENGTH);
		const asset = key.slice(BALANCE_PREFIX.length + ADDRESS_LENGTH + 1);
		if (asset === 'base')
			continue;
		const amount = assocVars[key];
		if (!(amount >= 0))
			throw Error(`unexpected negative balance for ${address} ${asset}: ${amount}`);
		if (amount === 0)
			continue;
		if (!outputsByAsset[asset])
			outputsByAsset[asset] = [];
		outputsByAsset[asset].push({ address, amount });
	}
	return outputsByAsset;
}

async function main() {
	await operator.start();
	network.start();
	const payer_address = operator.getAddress();
	console.error((bDryRun ? '[DRY RUN] ' : '') + 'paying out from ' + payer_address);

	const outputsByAsset = await getOutputsByAsset();
	const assets = Object.keys(outputsByAsset);
	console.error(`found ${assets.length} non-base asset(s) with a recorded balance in ${AA_ADDRESS}`);

	for (const asset of assets) {
		const outputs = outputsByAsset[asset];
		const total = outputs.reduce((sum, o) => sum + o.amount, 0);
		console.error(`asset ${asset}: ${outputs.length} owner(s), total ${total}`);
		if (bDryRun)
			for (const output of outputs)
				console.error(`  would send ${output.amount} of ${asset} to ${output.address}`);
	}

	if (!bDryRun) {
		const unit = await sendMultiPayment({
			outputs_by_asset: outputsByAsset,
			paying_addresses: [payer_address],
			change_address: payer_address,
			spend_unconfirmed: 'all',
		});
		console.error(`sent all payouts in a single unit ${unit}`);
	}
	console.error('done' + (bDryRun ? ' (dry run, set CONFIRM_DRAIN=1 to actually send)' : ''));
	process.exit(0);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
