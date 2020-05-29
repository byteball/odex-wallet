const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')


let client, db, response

const drop = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)
		response = await db.dropDatabase()

		client.close()
		console.log(response)
	} catch (e) {
		console.log(e.message)
	} finally {
		client.close()
	}
}

drop()