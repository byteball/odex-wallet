const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')

let client, db

const query = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)

		const trades = await db.collection('trades').find().toArray();
		console.log("will update " + trades.length + " entries")

		const ordersCollection = await db.collection('orders');
		for (var i = 0; i < trades.length; i++){
			const order = await ordersCollection.findOne({ "hash": { "$eq": trades[i].makerOrderHash } });
			if (!order){
				console.log(trades[i].makerOrderHash + " not found");
				continue;
			}

			const query = { hash: trades[i].hash };
			const values = { $set: {makerSide: order.side } };
			$unset: 
			await db.collection('trades').updateOne(query, values);
			console.log(order.side);
		}

	} catch (e) {
		console.log(e.message)
	} finally {
		client.close()
	}
}

query()