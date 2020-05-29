const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')


let client, db

const query = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)

		const pairs = await db.collection('pairs').find().toArray()
		const pair = pairs[0]
		const query = {
			"status": { $in: [ "OPEN", "PARTIALLY_FILLED" ]},
			"baseToken": pair.baseAsset,
			"quoteToken": pair.quoteAsset
		}

		const response = await db.collection('orders').find(query).toArray()
		console.log(response)

	} catch (e) {
		console.log(e.message)
	} finally {
		client.close()
	}
}

query()