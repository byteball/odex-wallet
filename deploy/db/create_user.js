const argv = require('yargs').argv
const user = argv.user
const pwd = argv.password
const conf = require('ocore/conf.js')

const MongoClient = require('mongodb').MongoClient
let client, db

const create = async () => {
	try {
		client = await MongoClient.connect(conf.mongoUrl, { useNewUrlParser: true });
		db = client.db(conf.mongoDbName)
		db.addUser(
			{
				username: user,
				password: pwd,
				options: {
					roles: [ { role: "userAdminAnyDatabase", db: "admin" } ]
				}
			}
		)
	} catch (e) {
		throw new Error(e.message)
	}
}


create()
