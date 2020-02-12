const constants = require('ocore/constants.js');
const ValidationUtils = require('ocore/validation_utils.js');


function isValidAsset(asset) {
	return (asset === 'base' || ValidationUtils.isValidBase64(asset, constants.HASH_LENGTH));
}

exports.isValidAsset = isValidAsset;
