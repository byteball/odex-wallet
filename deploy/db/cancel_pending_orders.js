const MongoClient = require('mongodb').MongoClient
const argv = require('yargs').argv
const conf = require('ocore/conf.js')

const pairName = argv.pair
const bDryRun = !!argv.dryRun

let client, db

const cancel = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)

		const query = { status: { $in: ['OPEN', 'PARTIALLY_FILLED'] } }
		if (pairName)
			query.pairName = pairName

		if (bDryRun) {
			const pendingOrders = await db.collection('orders').find(query).toArray()
			console.log(`dry run: ${pendingOrders.length} pending order(s) would be cancelled`)
			console.log(pendingOrders.map(order => order.hash))
			return
		}

		const response = await db.collection('orders').updateMany(query, {
			$set: { status: 'CANCELLED', updatedAt: new Date().toISOString() }
		})
		console.log(`matched ${response.matchedCount}, cancelled ${response.modifiedCount} pending order(s)`)

	} catch (e) {
		console.log(e.message)
	} finally {
		client.close()
	}
}

cancel()
