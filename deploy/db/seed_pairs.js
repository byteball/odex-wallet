const MongoClient = require('mongodb').MongoClient
const conf = require('ocore/conf.js')
const { getPairRank } = require('../utils/helpers')


let client, db, response

const seed = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)
		let pairs = []

		const tokens = await db.collection('tokens')
			.find(
				{ quote: false },
				{ symbol: 1, asset: 1, decimals: 1 }
			)
			.toArray()

		const quotes = await db.collection('tokens')
			.find(
				{ quote: true },
				{ symbol: 1, asset: 1, decimals: 1,  }
			)
			.sort({rank: -1})
			.toArray()

		
		quotes.forEach((quote, i) => {
			let nextQuotes = quotes.slice(i+1)

			nextQuotes.forEach(nextQuote => {
				pairs.push({
					baseTokenSymbol: nextQuote.symbol,
					baseAsset: nextQuote.asset,
					baseTokenDecimals: nextQuote.decimals,
					quoteTokenSymbol: quote.symbol,
					quoteAsset: quote.asset,
					quoteTokenDecimals: quote.decimals,
					active: true,
					listed: true,
					rank: getPairRank(nextQuote.symbol, quote.symbol),
					createdAt: Date(),
					updatedAt: Date()
				})
			})


			tokens.forEach(token => {
				pairs.push({
					baseTokenSymbol: token.symbol,
					baseAsset: token.asset,
					baseTokenDecimals: token.decimals,
					quoteTokenSymbol: quote.symbol,
					quoteAsset: quote.asset,
					quoteTokenDecimals: quote.decimals,
					active: true,
					listed: true,
					rank: getPairRank(token.symbol, quote.symbol),
					createdAt: Date(),
					updatedAt: Date()
				})
			})
		})

		const response = await db.collection('pairs').insertMany(pairs, {ordered: false})
	} catch (e) {
		console.log(e.message)
	} finally {
		client.close()
	}
}

seed()