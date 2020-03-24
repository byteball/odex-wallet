const constants = require('ocore/constants.js');
const ValidationUtils = require('ocore/validation_utils.js');
const eventBus = require('ocore/event_bus.js');
const signing = require('./signing.js');


function getCancelOrderPrefix() {
	return "Cancel order ";
}

function handleSignedCancel(objSignedMessage, assocAddressByOrderHash, handleResult) {
	if (!handleResult)
		return new Promise(function(resolve){
			handleSignedCancel(objSignedMessage, assocAddressByOrderHash, resolve);
		});
	if (typeof objSignedMessage.signed_message !== 'string')
		return handleResult("cancel message must be a string");
	let hash = objSignedMessage.signed_message.substr(getCancelOrderPrefix().length);
	if (!ValidationUtils.isValidBase64(hash, constants.HASH_LENGTH))
		return handleResult("bad hash: " + hash);
	signing.validateSignedMessage(objSignedMessage, err => {
		if (err)
			return handleResult(err);
		var address = objSignedMessage.authors[0].address;
		if (assocAddressByOrderHash && address !== assocAddressByOrderHash[hash])
			return handleResult(`You signed with a wrong address, please make sure you are in the wallet ${assocAddressByOrderHash[hash]}.`);
		eventBus.emit('cancel_order', { orderHash: hash, userAddress: address });
		console.error('---- cancel', hash, address);
		handleResult();
	});
}

/*
function verifyCancelSignature(c_order, cb) {
	const order_data = c_order.signed_message;
	if (!ValidationUtils.isValidBase64(c_order.last_ball_unit, constants.HASH_LENGTH))
		return cb('invalid last_ball_unit');
	if (!ValidationUtils.isValidBase64(order_data.id, constants.HASH_LENGTH))
		return cb('invalid order id');
	if (!ValidationUtils.isValidAddress(order_data.address))
		return cb('invalid address');
	signing.validateSignedMessage(c_order, err => {
		if (err)
			return cb(err);
		cb(null, order_data.address);
	});
}
*/

exports.getCancelOrderPrefix = getCancelOrderPrefix;
exports.handleSignedCancel = handleSignedCancel;

