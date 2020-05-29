require('dotenv').config()

const assetsBySymbols = require('./assetsBySymbols.json')
const quoteTokens = {
	testnet: ['USDC', 'GBYTE'],
	livenet: ['USD_20200701', 'BTC_20200701', 'GBYTE'],
}
const baseTokens = {
	testnet: [],
	livenet: [],
}


const decimals = {
	testnet: {
		"GBYTE": 9,
		"USDC": 6,
	},
	livenet: {
		"GBYTE": 9,
		"USD_20200701": 2,
		"BTC_20200701": 8,
	},
}

const tokenRanks = {
	testnet: {
		"GBYTE": 9,
		"USDC": 10,
	},
	livenet: {
		"USD_20200701": 10,
		"BTC_20200701": 8,
		"GBYTE": 6,
	},
}


module.exports = {
	quoteTokens,
	baseTokens,
	decimals,
	assetsBySymbols,
	tokenRanks
}