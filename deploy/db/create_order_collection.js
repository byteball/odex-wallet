const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')

const create = async () => {
	client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });

	const db = client.db(conf.mongoDbName)
	const response = await db.createCollection('orders', {
		validator:  {
			$jsonSchema: 'object',
			required: [
				'baseToken',
				'quoteToken',
				'amount',
				'price',
				'userAddress',
				'matcherAddress',
				'filledAmount',
				'amount',
			],
			properties:  {
				baseToken: {
					bsonType: "string",
				},
				quoteToken: {
					bsonType: "string",
				},
				filledAmount: {
					bsonType: "long"
				},
				amount: {
					bsonType: "long"
				},
				price: {
					bsonType: "double"
				},
				side: {
					bsonType: "string"
				},
				status: {
					bsonType: "string"
				},
				matcherAddress: {
					bsonType: "string"
				},
				affiliateAddress: {
					bsonType: "string"
				},
				userAddress: {
					bsonType: "string"
				},
				pairName: {
					bsonType: "string"
				},
				hash: {
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
}

create()
