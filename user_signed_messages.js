const cancels = require('./cancels.js');

function getSignedMessageType(signed_message) {
	if (typeof signed_message === 'string') {
		if (signed_message.startsWith(cancels.getCancelOrderPrefix()))
			return 'cancel';
		else
			return 'login';
	}
	else if (typeof signed_message === 'object')
		return 'order';
	else
		return null;
}

exports.getSignedMessageType = getSignedMessageType;
