const headlessWallet = require('headless-obyte');
const constants = require('ocore/constants.js');
const db = require('ocore/db.js');
const signed_message = require('ocore/signed_message.js');
const operator = require('./operator.js');

function signMessage(message, handleResult) {
	signed_message.signMessage(message, operator.getAddress(), headlessWallet.signer, false, handleResult);
}

function validateSignedMessage(objSignedMessage, handleResult) {
	if (!handleResult)
		return new Promise(function(resolve){
			validateSignedMessage(objSignedMessage, resolve);
		});
	try{
		var address = objSignedMessage.authors[0].address;
	}
	catch(e){
		return handleResult("broken signed message");
	}
	if (objSignedMessage.version === constants.versionWithoutTimestamp)
		return handleResult("wrong version of signed message");
	signed_message.validateSignedMessage(db, objSignedMessage, address, handleResult);
}

exports.signMessage = signMessage;
exports.validateSignedMessage = validateSignedMessage;
