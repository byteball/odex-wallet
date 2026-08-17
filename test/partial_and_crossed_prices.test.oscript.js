// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too

// Covers partially-filled orders (amount_left persistence across multiple matches)
// and crossed-price matching (trade always settles at the maker's price).

const path = require('path')

// mirrors the maker/taker sizing formula in dex.oscript's order-matching case
function computeFill(order1Price, amountLeft1, amountLeft2) {
	const buyAmount1 = Math.round(amountLeft1 * order1Price)
	if (buyAmount1 > amountLeft2) {
		const buyAmount2 = Math.round(amountLeft2 / order1Price)
		return {
			amountSold1: buyAmount2,
			amountSold2: amountLeft2,
			newAmountLeft1: amountLeft1 - buyAmount2,
			newAmountLeft2: 0,
		}
	}
	return {
		amountSold1: amountLeft1,
		amountSold2: buyAmount1,
		newAmountLeft1: 0,
		newAmountLeft2: amountLeft2 - buyAmount1,
	}
}

describe('Partially filled orders', function () {
	this.timeout(240000)

	before(async () => {
		this.network = await Network.create()
			.with.agent({ dex: path.join(__dirname, '../dex.oscript') })
			.with.asset({ tokenA: {} })
			.with.wallet({ alice: { base: 1e7, tokenA: 1000 } })
			.with.wallet({ bob: { base: 1e7 } })
			.with.wallet({ dave: { base: 1e7 } })
			.with.wallet({ matcher: { base: 1e7 } })
			.run()

		this.dexAa = this.network.agent.dex
		this.tokenA = this.network.asset.tokenA

		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.dave = this.network.wallet.dave
		this.daveAddress = await this.dave.getAddress()
		this.matcher = this.network.wallet.matcher
		this.matcherAddress = await this.matcher.getAddress()

		this.getVars = async () => (await this.alice.readAAStateVars(this.dexAa)).vars
		this.expectBalance = async (address, asset, expected) => {
			const vars = await this.getVars()
			expect(vars['balance_' + address + '_' + asset] || 0).to.equal(expected)
		}
	})

	it('Alice deposits tokenA, Bob and Dave deposit base', async () => {
		const { unit: aliceUnit, error: aliceError } = await this.alice.sendMulti({
			asset: this.tokenA,
			asset_outputs: [{ address: this.dexAa, amount: 1000 }],
			base_outputs: [{ address: this.dexAa, amount: 10000 }],
			change_address: this.aliceAddress,
		})
		expect(aliceError).to.be.null
		expect((await this.network.getAaResponseToUnit(aliceUnit)).response.bounced).to.be.false
		await this.network.witnessUntilStable(aliceUnit)

		const { unit: bobUnit, error: bobError } = await this.bob.sendBytes({ toAddress: this.dexAa, amount: 10000 })
		expect(bobError).to.be.null
		expect((await this.network.getAaResponseToUnit(bobUnit)).response.bounced).to.be.false
		await this.network.witnessUntilStable(bobUnit)

		const { unit: daveUnit, error: daveError } = await this.dave.sendBytes({ toAddress: this.dexAa, amount: 12000 })
		expect(daveError).to.be.null
		expect((await this.network.getAaResponseToUnit(daveUnit)).response.bounced).to.be.false
		await this.network.witnessUntilStable(daveUnit)
	})

	it('Bob only partially fills alice\'s order, leaving amount_left on alice\'s order', async () => {
		const order1 = {
			address: this.aliceAddress,
			sell_asset: this.tokenA,
			buy_asset: 'base',
			sell_amount: 1000,
			price: 10,
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: 'base',
		}
		const order2 = {
			address: this.bobAddress,
			sell_asset: 'base',
			buy_asset: this.tokenA,
			sell_amount: 4000,
			price: 0.1,
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: this.tokenA,
		}
		this.fill1 = computeFill(order1.price, order1.sell_amount, order2.sell_amount)
		expect(this.fill1.newAmountLeft2).to.equal(0) // bob (taker) fully filled
		expect(this.fill1.newAmountLeft1).to.be.above(0) // alice (maker) only partially filled

		const { signedPackage: signedOrder1 } = await this.alice.signMessage(order1)
		this.signedOrder1 = signedOrder1 // reused for the second, completing match
		const { signedPackage: signedOrder2 } = await this.bob.signMessage(order2)

		const { unit, error } = await this.matcher.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: signedOrder1, order2: signedOrder2 },
		})
		expect(error).to.be.null
		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		await this.network.witnessUntilStable(unit)

		const vars = await this.getVars()
		const amountLeftKey = Object.keys(vars).find(k => k.startsWith('amount_left_'))
		const executedKey = Object.keys(vars).find(k => k.startsWith('executed_'))
		expect(vars[amountLeftKey]).to.equal(this.fill1.newAmountLeft1)
		expect(executedKey).to.not.be.undefined // bob's order id, fully executed
		this.aliceOrderId = amountLeftKey.substring('amount_left_'.length)

		await this.expectBalance(this.aliceAddress, this.tokenA, 1000 - this.fill1.amountSold1)
		await this.expectBalance(this.aliceAddress, 'base', 10000 + this.fill1.amountSold2 - 1000) // deposit + proceeds - AA fee
		await this.expectBalance(this.bobAddress, 'base', 10000 - this.fill1.amountSold2 - 1000) // - AA fee
		await this.expectBalance(this.bobAddress, this.tokenA, this.fill1.amountSold1)
	})

	it('Dave completes the remainder of alice\'s order', async () => {
		const remaining = this.fill1.newAmountLeft1
		const order4 = {
			address: this.daveAddress,
			sell_asset: 'base',
			buy_asset: this.tokenA,
			sell_amount: Math.round(remaining * 10), // exactly enough to fill what's left, at alice's price
			price: 0.1,
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: this.tokenA,
		}
		this.fill2 = computeFill(10, remaining, order4.sell_amount)
		expect(this.fill2.newAmountLeft1).to.equal(0) // alice's order is now fully closed
		expect(this.fill2.newAmountLeft2).to.equal(0) // dave's order fully filled too

		const { signedPackage: signedOrder4 } = await this.dave.signMessage(order4)

		const { unit, error } = await this.matcher.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: this.signedOrder1, order2: signedOrder4 },
		})
		expect(error).to.be.null
		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		await this.network.witnessUntilStable(unit)

		const vars = await this.getVars()
		expect(vars['executed_' + this.aliceOrderId]).to.equal(1)
		expect(vars['amount_left_' + this.aliceOrderId]).to.not.be.ok // reset to false once fully executed

		const aliceTokenAAfterFirst = 1000 - this.fill1.amountSold1
		const aliceBaseAfterFirst = 10000 + this.fill1.amountSold2 - 1000
		await this.expectBalance(this.aliceAddress, this.tokenA, aliceTokenAAfterFirst - this.fill2.amountSold1)
		await this.expectBalance(this.aliceAddress, 'base', aliceBaseAfterFirst + this.fill2.amountSold2 - 1000)
		await this.expectBalance(this.daveAddress, 'base', 12000 - order4.sell_amount - 1000)
		await this.expectBalance(this.daveAddress, this.tokenA, this.fill2.amountSold1)
	})

	after(async () => {
		await this.network.stop()
	})
})

describe('Crossed prices', function () {
	this.timeout(240000)

	before(async () => {
		this.network = await Network.create()
			.with.agent({ dex: path.join(__dirname, '../dex.oscript') })
			.with.asset({ tokenA: {} })
			.with.wallet({ alice: { base: 1e7, tokenA: 500 } })
			.with.wallet({ bob: { base: 1e7 } })
			.with.wallet({ matcher: { base: 1e7 } })
			.run()

		this.dexAa = this.network.agent.dex
		this.tokenA = this.network.asset.tokenA

		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.matcher = this.network.wallet.matcher
		this.matcherAddress = await this.matcher.getAddress()

		this.getVars = async () => (await this.alice.readAAStateVars(this.dexAa)).vars
		this.expectBalance = async (address, asset, expected) => {
			const vars = await this.getVars()
			expect(vars['balance_' + address + '_' + asset] || 0).to.equal(expected)
		}

		const { unit: aliceUnit, error: aliceError } = await this.alice.sendMulti({
			asset: this.tokenA,
			asset_outputs: [{ address: this.dexAa, amount: 500 }],
			base_outputs: [{ address: this.dexAa, amount: 10000 }],
			change_address: this.aliceAddress,
		})
		expect(aliceError).to.be.null
		expect((await this.network.getAaResponseToUnit(aliceUnit)).response.bounced).to.be.false
		await this.network.witnessUntilStable(aliceUnit)

		const { unit: bobUnit, error: bobError } = await this.bob.sendBytes({ toAddress: this.dexAa, amount: 10000 })
		expect(bobError).to.be.null
		expect((await this.network.getAaResponseToUnit(bobUnit)).response.bounced).to.be.false
		await this.network.witnessUntilStable(bobUnit)
	})

	it('Non-overlapping prices bounce with a price mismatch, balances stay untouched', async () => {
		const order1 = {
			address: this.aliceAddress,
			sell_asset: this.tokenA,
			buy_asset: 'base',
			sell_amount: 500,
			price: 8, // alice asks 8 bytes per tokenA
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: 'base',
		}
		const order2 = {
			address: this.bobAddress,
			sell_asset: 'base',
			buy_asset: this.tokenA,
			sell_amount: 4000,
			price: 0.2, // bob only offers up to 5 bytes per tokenA: doesn't cross alice's ask
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: this.tokenA,
		}
		expect(order1.price * order2.price).to.be.above(1) // not compatible

		const { signedPackage: signedOrder1 } = await this.alice.signMessage(order1)
		const { signedPackage: signedOrder2 } = await this.bob.signMessage(order2)

		const { unit, error } = await this.matcher.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: signedOrder1, order2: signedOrder2 },
		})
		expect(error).to.be.null
		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.bounced).to.be.true
		expect(response.response.error.message).to.equal('price mismatch')

		await this.expectBalance(this.aliceAddress, this.tokenA, 500)
		await this.expectBalance(this.bobAddress, 'base', 10000)
	})

	it('Overlapping (crossed) prices settle at the maker\'s price', async () => {
		const order1 = {
			address: this.aliceAddress,
			sell_asset: this.tokenA,
			buy_asset: 'base',
			sell_amount: 500,
			price: 8, // maker price: alice asks 8 bytes per tokenA
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: 'base',
		}
		const order2 = {
			address: this.bobAddress,
			sell_asset: 'base',
			buy_asset: this.tokenA,
			sell_amount: 4000,
			price: 0.1, // bob would pay up to 10 bytes per tokenA: crosses alice's ask
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: this.tokenA,
		}
		expect(order1.price * order2.price).to.be.below(1) // compatible, crossed

		const fill = computeFill(order1.price, order1.sell_amount, order2.sell_amount)
		expect(fill.newAmountLeft1).to.equal(0)
		expect(fill.newAmountLeft2).to.equal(0)

		const { signedPackage: signedOrder1 } = await this.alice.signMessage(order1)
		const { signedPackage: signedOrder2 } = await this.bob.signMessage(order2)

		const { unit, error } = await this.matcher.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: signedOrder1, order2: signedOrder2 },
		})
		expect(error).to.be.null
		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		await this.network.witnessUntilStable(unit)

		// bob paid the maker's price (8 bytes/tokenA), not his own more generous limit (10 bytes/tokenA)
		expect(fill.amountSold2 / fill.amountSold1).to.equal(order1.price)

		await this.expectBalance(this.aliceAddress, this.tokenA, 500 - fill.amountSold1)
		await this.expectBalance(this.aliceAddress, 'base', 10000 + fill.amountSold2 - 1000) // deposit + proceeds - AA fee
		await this.expectBalance(this.bobAddress, 'base', 10000 - fill.amountSold2 - 1000) // - AA fee
		await this.expectBalance(this.bobAddress, this.tokenA, fill.amountSold1)
	})

	after(async () => {
		await this.network.stop()
	})
})
