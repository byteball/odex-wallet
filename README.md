# ODEX Decentralized Exchange

The ODEX decentralized exchange is a hybrid decentralized exchange that aims at bringing together the ease of use of centralized exchanges along with the security and privacy features of decentralized exchanges. Orders are matched through an off-chain orderbook. After orders are matched and signed, the decentralized exchange operator (matcher) has the sole ability to perform a transaction to the Autonomous Agent. This provides for the best UX as the exchange operator is the only party having to interact directly with the DAG. Exchange users simply sign orders which are broadcasted then to the orderbook. This design enables users to queue and cancel their orders seamlessly.

Several matchers can operate exchanges based on ODEX technology at the same time. They share their orderbooks and exchange all new orders among themselves, thus improving liquidity for all ODEX exchanges. An order can be submitted through any ODEX exchange, however to be matched, both maker and taker orders have to indicate the same matcher. The exchange that was used to submit the order serves as an affliate and can charge a fee from its users.  Anyone can become a matcher or affiliate, or just watch the orders that are being exchanged among the matchers and detect any possible misbehavior by matchers.


## Install
```
git clone https://github.com/byteball/odex-wallet
cd odex-wallet
npm install
```
Copy `.env.testnet` file to `.env` if you are working on testnet.

## Run
```
node run.js
```
Run this from `screen` or `tmux` session and detach after starting, or start it in the background while redirecting all output:
```
node run.js 1>log 2>errlog &
```

## Architecture
The DEX consists of 4 layers:
* An Autonomous Agent, written in [Oscript](https://developer.obyte.org/autonomous-agents), that tracks user balances and executes trades.
* DEX wallet, written in nodejs (this repo). It includes an Obyte node and is reponsible for:
	* sending matched trades to the AA foe execution;
	* watching the DAG for deposits/withdrawals and sending events to the backend (which in turn forwards them to clients);
	* receiving orders and cancels from users through a chatbot;
	* logging in users through a chatbot;
	* exchanging new orders, cancels, and trades with other matchers (ODEXes) through websocket connections.
* [DEX backend](https://github.com/byteball/odex-backend), written in go. It is responsible for:
	* matching orders;
	* serving REST and websocket endponts for frontend and bot clients;
	* forwarding events from DEX wallet to clients (browsers and bots).
* [DEX frontend](https://github.com/byteball/odex-frontend), written in react. It is the UI users use to interact with the exchange.

Orders, trades, and other information is stored in a mongodb database. It is most actively used by ODEX backend but ODEX wallet also has access to it.

Backend and wallet interact through JSON-RPC and websocket connections.

## How to run your own ODEX node

* Install all 3 repos: wallet, backend, and frontend (the AA is a public service and is shared among all ODEX instances in order to share liquidity).
* Configure your node:
	* decide which network you run, livenet or testnet, and copy the corresponding .env.XXX file to .env in wallet and frontend;
	* find all mentions of odex.ooo domain name in the frontend and replace them with your domain name;
	* set up nginx according to example config file in the frontend repo (make sure you edit the domain name and document root path);
	* edit the chatbot name (`deviceName`) in conf.js or conf.json of your wallet. Make sure it reflects your donmain name so that users don't confuse it with chatbots of other ODEXes.
	* add `admin_email` and `from_email` in conf.js or conf.json of your wallet. This is the address where you'll receive notifications in case of issues with your wallet, such as insufficient balance to send a trade to the AA. Set up `sendmail` or another way to deliver email (such as user/pass for an email account).
	* decide whether you run full or light node. Light node is much faster to start and takes much less disk space but it is slower to see the finality of transactions and you might run into issues as your exchange node grows. Migration from light to full is easy should you need it. Set the corresponding `bLight` option in conf.js or conf.json of your wallet.
	* when you first start the wallet, note the pairing code that it prints, copy it to `CHATBOT_TESTNET_URL` or `CHATBOT_LIVENET_URL` (depending on which network you run) in `src/config/urls.js` of the frontend.
	* when you first start the wallet, note the address that it prints. Send some Bytes (0.1 GBYTE is recommended) to this address for your node to be able to pay for fees when it sends trades for execution to the AA.
	* set the `myUrl` and `port` in conf.js or conf.json of your wallet. Other ODEX nodes will connect to your `myUrl` to exchange information about new orders, cancels, and trades. `port` is for your nginx to proxy websocket connections to your node. Set up nginx to accept websocket connections on `myUrl` and proxy them to localhost:port.
	* if you run a full node, it will automatically discover other ODEX nodes and connect to them. If you run a light node, you might want to help it discover other ODExes by specifying the URLs of their Obyte nodes in `light_peers` of the wallet (see an example in conf.js).
	* optionally set up TOR for security (attackers won't know your IP) and privacy. Specify `socksHost` and `socksPort` in conf.js or conf.json of your wallet. Note that by running a web server you are exposing your IP, use a reverse proxy such as cloudflare to keep it private.
	* review other options you might want to edit in wallet's conf.js. In particular, check out `matcher_fee`, `affiliate_fee`, `MIN_BALANCE_FOR_REFILL`, `MIN_BALANCE_FOR_NOTIFICATION`.
* follow the instructions in frontend and wallet repos to start them.


# Contributions

Thank you for considering helping the ODEX project! We accept contributions from anyone and are grateful even for the smallest fixes.

If you want to help ODEX, please fork and setup the development environment of the appropriate repository. In the case you want to submit substantial changes, please get in touch with our development team on #odex channel in [Obyte discord](https://discord.obyte.org) to verify those modifications are in line with the general goal of the project and receive early feedback. Otherwise you are welcome to fix, commit and send a pull request for the maintainers to review and merge into the main code base.

Please make sure your contributions adhere to our coding guidelines:

Code must adhere as much as possible to standard conventions (DRY - Separation of concerns - Modular)
Pull requests need to be based and opened against the master branch
Commit messages should properly describe the code modified
Ensure all tests are passing before submitting a pull request

# Contact

If you have questions, ideas or suggestions, you can reach our development team on #odex channel in [Obyte discord](https://discord.obyte.org)

# License

All the code in this repository is licensed under the MIT License, also included here in the LICENSE file.
