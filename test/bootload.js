/* eslint-disable chai-friendly/no-unused-expressions */
const path = require('path')
const chai = require('chai')
const expect = chai.expect
const deepEqualInAnyOrder = require('deep-equal-in-any-order')
const mapValues = require('lodash.mapvalues')
const sortAny = require('sort-any')
const { Testkit } = require('aa-testkit')
const { Network, Nodes, Utils } = Testkit({
	TESTDATA_DIR: path.join(process.cwd(), 'testdata')
})

global.expect = expect
global.Testkit = Testkit

global.Network = Network
global.Nodes = Nodes
global.Utils = Utils


function round(n, precision) {
	return parseFloat(n.toPrecision(precision));
}

const sortDeep = (object) => {
	if (!Array.isArray(object)) {
		if (typeof object !== 'object' || object === null || object instanceof Date) {
			return object;
		}

		return mapValues(object, sortDeep);
	}

	return sortAny(object.map(sortDeep));
};

chai.use(deepEqualInAnyOrder)

chai.use((_chai, utils) => {
	chai.Assertion.addProperty('validAddress', function () {
		const address = utils.flag(this, 'object')
		const negate = utils.flag(this, 'negate')
		const check = Utils.isValidAddress(address)
		new chai.Assertion(check).to.be.equal(!negate, !check && `'${JSON.stringify(address)}' is not valid address`)
	})

	chai.Assertion.addProperty('validUnit', function () {
		const unit = utils.flag(this, 'object')
		const negate = utils.flag(this, 'negate')
		const check = Utils.isValidBase64(unit, 44) && unit.endsWith('=')
		new chai.Assertion(check).to.be.equal(!negate, !check && `'${JSON.stringify(unit)}' is not valid unit`)
	})
	
	chai.Assertion.addMethod("deepCloseTo", function (expected, delta, msg) {
		let actual = utils.flag(this, "object");

		new chai.Assertion(typeof actual).to.be.eq(typeof expected, 'type mismatch')

		if (typeof actual !== 'object') {
			if (typeof actual === 'number' && delta)
				return this.closeTo(expected, delta, msg);
			else
				return this.equal(expected, msg);
		}

		new chai.Assertion(Array.isArray(actual)).to.be.eq(Array.isArray(expected), 'comparing object and array')

		msg = msg || "";
		if (Array.isArray(actual)) {
			new chai.Assertion(actual.length).to.be.eq(expected.length, 'array length mismatch')
			actual = sortDeep(actual)
			expected = sortDeep(expected)
			for (let i = 0, imax = actual.length; i < imax; ++i) {
				new chai.Assertion(actual[i]).deepCloseTo(expected[i], delta, msg + "[" + i + "]");
			}
		}
		else {
			new chai.Assertion(Object.keys(actual).length).to.be.eq(Object.keys(expected).length, 'object length mismatch')
			for (let key in actual) {
				new chai.Assertion(actual[key]).deepCloseTo(expected[key], delta, msg + "[" + key + "]");
			}
		}

		//	return this;
	});
})
