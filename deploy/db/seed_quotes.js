const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')
const { getNetworkID } = require('../utils/helpers')




const networkID = getNetworkID()
const { quoteTokens, baseTokens, assetsBySymbols, decimals, tokenRanks } = require('../config')

let documents = []
let assets = assetsBySymbols[networkID]

let client, db, response

const seed = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)

		documents = quoteTokens[networkID].map((symbol) => ({
			symbol: symbol,
			asset: assets[symbol],
			decimals: decimals[networkID][symbol],
			quote: true,
			listed: true,
			rank: tokenRanks[networkID][symbol] || 0,
			createdAt: Date(),
			updatedAt: Date()
		}))

		response = await db.collection('tokens').insertMany(documents)
		client.close()
	} catch (e) {
		throw new Error(e.message)
	} finally {
		client.close()
	}
}

seed()
