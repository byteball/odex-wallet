const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')


let client, db, response

const query = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)

		const response = await db.collection('tokens').find().toArray()
		console.log(response)

	} catch (e) {
		console.log(e.message)
	} finally {
		client.close()
	}
}

query()