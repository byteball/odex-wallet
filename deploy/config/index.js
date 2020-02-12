require('dotenv').config()

const assetsBySymbols = require('./assetsBySymbols.json')
const quoteTokens = ['USDC', 'GBYTE']
const baseTokens = [ ]


const decimals = {
	"GBYTE": 9,
	"USDC": 6
}

const tokenRanks = {
	"GBYTE": 9,
	"USDC": 10
}


module.exports = {
	quoteTokens,
	baseTokens,
	decimals,
	assetsBySymbols,
	tokenRanks
}