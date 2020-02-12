const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js');
const mutex = require('ocore/mutex.js');

let mongodb;

async function getMongo() {
	if (mongodb)
		return mongodb;
	const unlock = await lock('mongo');
	let client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
	mongodb = client.db(conf.mongoDbName);
	unlock();
	return mongodb;
}

function lock(key) {
	return new Promise(resolve => mutex.lock([key], resolve));
}

exports.getMongo = getMongo;
