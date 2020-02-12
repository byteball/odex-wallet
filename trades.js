const ValidationUtils = require('ocore/validation_utils.js');
const operator = require('./operator.js');


function parseTrade(matches) {
	try {
		var taker_order = matches.takerOrder.originalOrder;
		var maker_orders = matches.makerOrders.map(be_maker_order => be_maker_order.originalOrder);
		var arrAddresses = [taker_order.signed_message.address];
		var matcher = taker_order.signed_message.matcher;
		if (!ValidationUtils.isValidAddress(matcher))
			return { err: "bad taker matcher address" };
		for (let i = 0; i < maker_orders.length; i++)
			if (maker_orders[i].signed_message.matcher !== matcher)
				return { err: "different maker matcher address" };
	}
	catch (e) {
		return { err: e.toString() };
	}
	const bMyTrade = (matcher === operator.getAddress());
	maker_orders.forEach(maker_order => {
		let address = maker_order.signed_message.address;
		if (!arrAddresses.includes(address))
			arrAddresses.push(address);
	});
	return { bMyTrade, taker_order, maker_orders, addresses: arrAddresses };
}


exports.parseTrade = parseTrade;

