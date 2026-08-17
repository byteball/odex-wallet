// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too

// Covers normal DEX operation with a matcher distinct from the traders, non-zero
// matcher/affiliate fees: deposit, trade, onchain cancel, grant, trade with a
// granted signer, and withdraw.

const path = require('path')

describe('Simple DEX trades', function () {
	this.timeout(240000)

	before(async () => {
		this.network = await Network.create()
			.with.agent({ dex: path.join(__dirname, '../dex.oscript') })
			.with.asset({ tokenA: {} })
			.with.wallet({ alice: { base: 1e7, tokenA: 3000 } })
			.with.wallet({ bob: { base: 1e7 } })
			.with.wallet({ matcher: { base: 1e7 } })
			.with.wallet({ carol: { base: 1e6 } })
			.with.wallet({ affiliate: { base: 1e6 } })
			.run()

		this.dexAa = this.network.agent.dex
		this.tokenA = this.network.asset.tokenA

		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()

		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()

		this.matcher = this.network.wallet.matcher
		this.matcherAddress = await this.matcher.getAddress()

		this.carol = this.network.wallet.carol
		this.carolAddress = await this.carol.getAddress()

		this.affiliate = this.network.wallet.affiliate
		this.affiliateAddress = await this.affiliate.getAddress()

		this.expectBalance = async (address, asset, expected) => {
			const { vars } = await this.alice.readAAStateVars(this.dexAa)
			expect(vars['balance_' + address + '_' + asset] || 0).to.equal(expected)
		}
	})

	it('Alice deposits tokenA, Bob deposits base', async () => {
		const { unit: aliceUnit, error: aliceError } = await this.alice.sendMulti({
			asset: this.tokenA,
			asset_outputs: [{ address: this.dexAa, amount: 3000 }],
			base_outputs: [{ address: this.dexAa, amount: 10000 }],
			change_address: this.aliceAddress,
		})
		expect(aliceError).to.be.null
		expect(aliceUnit).to.be.validUnit
		const { response: aliceResponse } = await this.network.getAaResponseToUnit(aliceUnit)
		expect(aliceResponse.response.error).to.be.undefined
		expect(aliceResponse.bounced).to.be.false
		await this.network.witnessUntilStable(aliceUnit)

		// the base attached to cover the deposit fee threshold is credited too, not consumed
		await this.expectBalance(this.aliceAddress, this.tokenA, 3000)
		await this.expectBalance(this.aliceAddress, 'base', 10000)

		const { unit: bobUnit, error: bobError } = await this.bob.sendBytes({ toAddress: this.dexAa, amount: 30000 })
		expect(bobError).to.be.null
		const { response: bobResponse } = await this.network.getAaResponseToUnit(bobUnit)
		expect(bobResponse.bounced).to.be.false
		await this.network.witnessUntilStable(bobUnit)

		await this.expectBalance(this.bobAddress, 'base', 30000)
	})

	it('Matcher matches Alice and Bob orders, charging matcher and affiliate fees', async () => {
		const order1 = { // alice sells tokenA for base
			address: this.aliceAddress,
			sell_asset: this.tokenA,
			buy_asset: 'base',
			sell_amount: 1000,
			price: 10,
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 100,
			matcher_fee_asset: 'base',
			affiliate: this.affiliateAddress,
			affiliate_fee_asset: 'base',
			affiliate_fee: 50,
		}
		const order2 = { // bob sells base for tokenA
			address: this.bobAddress,
			sell_asset: 'base',
			buy_asset: this.tokenA,
			sell_amount: 10000,
			price: 0.1,
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 50,
			matcher_fee_asset: this.tokenA,
		}

		const { signedPackage: signedOrder1 } = await this.alice.signMessage(order1)
		const { signedPackage: signedOrder2 } = await this.bob.signMessage(order2)

		const { unit, error } = await this.matcher.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: signedOrder1, order2: signedOrder2 },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.event).to.equal('trade')
		await this.network.witnessUntilStable(unit)

		// both orders fully fill: 1000 tokenA <-> 10000 base
		await this.expectBalance(this.aliceAddress, this.tokenA, 2000) // 3000 - 1000
		await this.expectBalance(this.aliceAddress, 'base', 18850) // 10000 + 10000 - 100 (matcher fee) - 50 (affiliate fee) - 1000 (AA fee)
		await this.expectBalance(this.bobAddress, 'base', 19000) // 30000 - 10000 - 1000 (AA fee)
		await this.expectBalance(this.bobAddress, this.tokenA, 950) // 1000 - 50 (matcher fee)
		await this.expectBalance(this.matcherAddress, 'base', 10100) // 100 (fee) + 10000 (refunded trigger bytes)
		await this.expectBalance(this.matcherAddress, this.tokenA, 50) // matcher fee from order2
		await this.expectBalance(this.affiliateAddress, 'base', 50) // affiliate fee from order1
	})

	it('Alice cancels an order onchain and gets a partial fee refund', async () => {
		const orderToCancel = {
			address: this.aliceAddress,
			sell_asset: this.tokenA,
			buy_asset: 'base',
			sell_amount: 500,
			price: 5,
			matcher: this.matcherAddress,
			aa: this.dexAa,
		}
		const { signedPackage: signedOrder } = await this.alice.signMessage(orderToCancel)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { cancel: true, order: signedOrder },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.event).to.equal('cancel')
		await this.network.witnessUntilStable(unit)

		// cancelling doesn't touch the sell-asset balance, only refunds attached bytes minus the cancel fee
		await this.expectBalance(this.aliceAddress, this.tokenA, 2000)
		await this.expectBalance(this.aliceAddress, 'base', 27850) // 18850 + 10000 - 1000 (cancel fee)
	})

	it('Alice grants Carol authorization to sign orders on her behalf', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { grant: true, address: this.carolAddress },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.event).to.equal('grant')
		await this.network.witnessUntilStable(unit)

		const { vars } = await this.alice.readAAStateVars(this.dexAa)
		expect(vars['grant_' + this.aliceAddress + '_to_' + this.carolAddress]).to.equal(1)
		// the grant call also deposits the attached bytes, same as a plain deposit
		await this.expectBalance(this.aliceAddress, 'base', 37850) // 27850 + 10000
	})

	it('Carol signs an order for Alice, matcher matches it against a new Bob order', async () => {
		const order3 = { // signed by carol, but owned by alice
			address: this.aliceAddress,
			sell_asset: this.tokenA,
			buy_asset: 'base',
			sell_amount: 800,
			price: 5,
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 40,
			matcher_fee_asset: 'base',
		}
		const order4 = {
			address: this.bobAddress,
			sell_asset: 'base',
			buy_asset: this.tokenA,
			sell_amount: 4000,
			price: 0.2,
			matcher: this.matcherAddress,
			aa: this.dexAa,
			matcher_fee: 20,
			matcher_fee_asset: this.tokenA,
		}

		const { signedPackage: signedOrder3 } = await this.carol.signMessage(order3)
		const { signedPackage: signedOrder4 } = await this.bob.signMessage(order4)

		const { unit, error } = await this.matcher.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: signedOrder3, order2: signedOrder4 },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.event).to.equal('trade')
		await this.network.witnessUntilStable(unit)

		// the trade is funded from alice's own balance even though carol signed it
		await this.expectBalance(this.aliceAddress, this.tokenA, 1200) // 2000 - 800
		await this.expectBalance(this.aliceAddress, 'base', 40810) // 37850 + 4000 - 40 (matcher fee) - 1000 (AA fee)
		await this.expectBalance(this.bobAddress, 'base', 14000) // 19000 - 4000 - 1000 (AA fee)
		await this.expectBalance(this.bobAddress, this.tokenA, 1730) // 950 + 800 - 20 (matcher fee)
		await this.expectBalance(this.matcherAddress, 'base', 20140) // 10100 + 40 (fee) + 10000 (refunded trigger bytes)
		await this.expectBalance(this.matcherAddress, this.tokenA, 70) // 50 + 20 (fee from order4)
	})

	it('Alice withdraws part of her base balance', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { withdraw: true, asset: 'base', amount: 5000 },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const paymentMessage = response.objResponseUnit.messages.find(m => m.app === 'payment' && !m.payload.asset)
		expect(paymentMessage).to.not.be.undefined
		expect(paymentMessage.payload.outputs.some(o => o.address === this.aliceAddress && o.amount === 5000)).to.be.true
		await this.network.witnessUntilStable(unit)

		await this.expectBalance(this.aliceAddress, 'base', 35810) // 40810 - 5000
	})

	it('Matcher withdraws all its earned base fees', async () => {
		const { unit, error } = await this.matcher.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { withdraw: true, asset: 'base', amount: 'all' },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const paymentMessage = response.objResponseUnit.messages.find(m => m.app === 'payment' && !m.payload.asset)
		expect(paymentMessage).to.not.be.undefined
		expect(paymentMessage.payload.outputs.some(o => o.address === this.matcherAddress && o.amount === 20140)).to.be.true
		await this.network.witnessUntilStable(unit)

		await this.expectBalance(this.matcherAddress, 'base', 0)
	})

	after(async () => {
		await this.network.stop()
	})
})
