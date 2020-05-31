const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')

const create = async () => {
	client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
	const db = client.db(conf.mongoDbName)

	const response = await db.createCollection('pairs', {
		validator:  {
			$jsonSchema: 'object',
			required: [ 'baseAsset', 'quoteAsset'],
			properties:  {
				name: {
					bsonType: "string",
					description: "must be a string and is not required"
				},
				baseToken: {
					bsonType: "objectId",
				},
				baseTokenSymbol: {
					bsonType: "string",
					description: "must be a a string and is not required"
				},
				baseAsset: {
					bsonType: "string",
					description: "must be a string and is required"
				},
				quoteToken: {
					bsonType: "objectId"
				},
				quoteTokenSymbol: {
					bsonType: "string",
					description: "must be a string and is required"
				},
				quoteAsset: {
					bsonType: "string",
					description: "must be a string and is required"
				},
				active: {
					bsonType: "bool",
					description: "must be a boolean and is not required"
				},
				makerFee: {
					bsonType: "double",
				},
				takerFee: {
					bsonType: "double"
				},
				createdAt: {
					bsonType: "date"
				},
				updatedAt: {
					bsonType: "date"
				}
			}
		}
	})

	console.log(response)
}

create()

