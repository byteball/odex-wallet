const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')

(async () => {
	client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });

	const db = client.db(conf.mongoDbName)
	const response = await db.createCollection('trades', {
		validator:  {
			$jsonSchema: 'object',
			properties:  {
				orderHash: {
					bsonType: "string",
				},
				amount: {
					bsonType: "long",
				},
				quoteAmount: {
					bsonType: "long",
				},
				remainingTakerSellAmount: {
					bsonType: "long",
				},
				remainingMakerSellAmount: {
					bsonType: "long",
				},
				price: {
					bsonType: "double"
				},
				maker: {
					bsonType: "string"
				},
				taker: {
					bsonType: "string"
				},
				takerOrderHash: {
					bsonType: "string"
				},
				makerOrderHash: {
					bsonType: "string"
				},
				hash: {
					bsonType: "string"
				},
				txHash: {
					bsonType: "string"
				},
				pairName: {
					bsonType: "string"
				},
				baseToken: {
					bsontype: "string"
				},
				quoteToken: {
					bsonType: "string"
				},
				createdAt: {
					bsonType: "string"
				},
				updatedAt: {
					bsonType: "string"
				}
			}
		}
	})

	console.log(response)
})()

