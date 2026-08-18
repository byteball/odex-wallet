/*jslint node: true */
"use strict";
const fs = require('fs');
const objectHash = require("ocore/object_hash.js");
const { parse } = require("ocore/formula/parse_ojson.js");

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});

const file = process.argv[2];
const prefix = process.argv[3];
if (!prefix) {
	console.error(`Usage: node find-nonce.js oscriptfile prefix`);
	console.error(`E.g.: node find-nonce.js dex.oscript ODEX`);
	process.exit();
}

const re = /\/\* nonce: \w+ \*\//;

function findNonce(definition) {
//	const prefixRe = new RegExp('^' + prefix);
	let nonce = 0;
	console.error(`searching for nonce matching prefix ${prefix} ...`);
	const start_ts = Date.now();
	const printProgress = () => {
		const elapsed = Date.now() - start_ts;
		console.error(`trying ${nonce}, ${nonce / elapsed * 1000} nonces/sec`);
	};
	const interval = setInterval(printProgress, 10 * 1000);
	let address;
	do {
		nonce++;
		definition[1].getters = definition[1].getters.replace(re, `/* nonce: ${nonce} */`);
		address = objectHash.getChash160(definition);
		if (nonce % 100000 === 0)
			printProgress();
	}
	while (!address.startsWith(prefix));
	clearInterval(interval);
	console.error(`found AA ${address} with nonce ${nonce}, search took ${(Date.now() - start_ts)/1000} seconds`);
}


function start() {
	const strInitialDefinition = fs.readFileSync(file, 'utf8');
	parse(strInitialDefinition, (err, definition) => {
		if (err)
			throw Error(err);
	//	console.log(definition[1].getters);
		findNonce(definition);
		process.exit();
	});
}

start();
