const MongoClient = require('mongodb').MongoClient
const argv = require('yargs').argv
const conf = require('ocore/conf.js')

const collection = argv.collection


let client, db, response

const drop = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)
		response = await db.dropCollection(collection)
		console.log(response)
	} catch(e) {
		console.log(e.message)
	} finally {
		client.close()
	}
}

drop()