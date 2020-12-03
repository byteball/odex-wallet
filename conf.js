/*jslint node: true */
"use strict";

//exports.port = 6611;
//exports.myUrl = 'wss://mydomain.com/bb';

// for local testing
//exports.WS_PROTOCOL === 'ws://';
//exports.port = 16611;
//exports.myUrl = 'ws://127.0.0.1:' + exports.port;

// other ODEX instances (only if our node is light)
//exports.light_peers = ['ws://127.0.0.1:16612'];

exports.bServeAsHub = false;
exports.bLight = false;

exports.storage = 'sqlite';

exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'ODEX Wallet';
exports.permanent_pairing_secret = '*';
exports.control_addresses = ['DEVICE ALLOWED TO CHAT'];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';
exports.bSingleAddress = true;
exports.bWantNewPeers = true;
exports.KEYS_FILENAME = 'keys.json';

// TOR
//exports.socksHost = '127.0.0.1';
//exports.socksPort = 9050;

exports.bNoPassphrase = true;

exports.explicitStart = true;

exports.MAX_PRICE_PRECISION = 8; // number of significant digits
exports.matcher_fee = 0.001;
exports.matcher_fee_max = 0.005; // max fee for a replicated order to be accepted

exports.affiliate_fee = 0.001;
exports.aa_address = 'FVRZTCFXIDQ3EYRGQSLE5AMWUQF4PRYJ';
exports.token_registry_aa_address = 'O6H6ZIFI57X3PLTYHOCVYPP5A553CYFQ';
exports.short_lived_token_registry_aa_address = 'XVIFA4GZO7IHAUBFU47GSWMBZYOY56ZD';

exports.allowed_namers = process.env.testnet ? [
	{
		base_aa: "ZZEVOHYFMAR4GOVTD4ZFZOAAHBJS5ZIY",
		oracle: "4EHFJW5EY74DG6PGSXX5CHF5F2FFIJX4"
	}
] : [
	{
		base_aa: "ZZEVOHYFMAR4GOVTD4ZFZOAAHBJS5ZIY",
		oracle: "TKT4UESIKTTRALRRLWS4SENSTJX6ODCW"
	}
];


exports.rpcPort = process.env.testnet ? 16333 : 6333;
exports.mongoUrl = 'mongodb://localhost:27017';
exports.mongoDbName = process.env.testnet ? 'odex_test' : 'odex';
exports.backendEnvironment = process.env.testnet ? 'testnet' : 'livenet';

exports.MIN_BALANCE_FOR_REFILL = 1e6;
exports.MIN_BALANCE_FOR_NOTIFICATION = 1e6;


console.log('finished odex conf');
