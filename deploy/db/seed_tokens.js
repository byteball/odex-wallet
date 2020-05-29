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

		//console.log(client)
		if (baseTokens[networkID].length === 0)
			return;

		documents = baseTokens[networkID].map((symbol) => ({
			symbol: symbol,
			asset: assets[symbol],
			decimals: decimals[networkID][symbol],
			active: true,
			quote: false,
			listed: true,
			rank: tokenRanks[networkID][symbol] || 0,
			createdAt: Date(),
			updatedAt: Date()
		}))

		response = await db.collection('tokens').insertMany(documents)
		client.close()
	} catch (e) {
		console.log(e)
		throw new Error(e.message)
	} finally { 
		client.close()
	}
}

seed()