'use strict'

const imap = require('./imap')
const { MailParser } = require('mailparser') // Requires 0.x as 2.x will fail listing all attachments
const talon = require('talon')
const debug = require('debug')('mailbot')
const address = require('address-rfc2822')


const createBot = (conf = {}) => {
	conf = Object.assign({
		imap: Object.assign({
			// user,
			// password,
			host: 'imap.googlemail.com',
			port: 993,
			keepalive: true,
			tls: true,
			tlsOptions: {
				rejectUnauthorized: false,
			},
		}, conf.imap),
		mailbox: 'INBOX',
		filter: ['UNSEEN'],
		markSeen: true,
		triggerOnHeaders: false,
		trigger: mail => false, // eslint-disable-line no-unused-vars
		mailHandler: (mail, trigger) => {}, // eslint-disable-line no-unused-vars
		errorHandler: (error, context) => console.error('MailBot Error', context, error), // eslint-disable-line no-console
		autoReconnect: true,
		autoReconnectTimeout: 5000,
		streamAttachments: true,
	}, conf)

	const handleError = context => error => {
		debug('Error', context, error)
		Promise.resolve()
		.then(() => conf.errorHandler(error, context))
		.catch(err => console.error('MAILBOT: ErrorHandler Error!', context, err)) // eslint-disable-line no-console
	}

	const handleMail = (mail, triggerResult) => {
		Promise.resolve()
		.then(() => conf.mailHandler(mail, triggerResult))
		.catch(handleError('MAIL'))
	}

	// Internal date of the latest received mail
	let latestDate = null

	// Open mailbox
	client.once('ready', () => {
		debug('IMAP ready')
		client.openBoxP(conf.mailbox, false)
		.then(() => {
			debug('Mailbox open')
			return client.searchP(conf.filter)
		})
		.then(uids => {
			debug('Initial search', uids)
			watch()
			return uids
		})
		.then(fetchAndParse)
		.catch(handleError('INITIAL_SEARCH'))
	})

	const watch = () => client.on('mail', nb => {
		debug('New mail', nb)
		client.searchP(conf.filter.concat(['SINCE', latestDate]))
		.then(uids => {
			debug('Incremental search', uids)
			return uids
		})
		.then(fetchAndParse)
		.catch(handleError('INCREMENTAL_SEARCH'))
	})

	client.on('close', err => {
		debug('IMAP disconnected', err)
		if (err && conf.autoReconnect) {
			debug('Trying to reconnect…')
			setTimeout(() => client.connect(), conf.autoReconnectTimeout)
		} else {
			debug('No reconnection (user close or no autoReconnect)')
		}
	})

	client.on('error', handleError('IMAP_ERROR'))

	const fetchAndParse = source => {
		debug('Fetch', source)
		const fetcher = client.fetch(source, {
			bodies: '',
			struct: true,
			markSeen: conf.markSeen,
		})
		fetcher.on('message', parseMessage)
		return new Promise((resolve, reject) => {
			fetcher.on('end', resolve)
			fetcher.on('error', reject)
		})
	}

	const parseMessage = message => {
		debug('Parse message')

		const parser = new MailParser({
			debug: conf.debugMailParser,
			streamAttachments: conf.streamAttachments,
			showAttachmentLinks: true,
		})

		// Message stream, so we can interrupt parsing if required
		let messageStream = null

		// Result of conf.trigger, testing if mail should trigger handler or not
		let triggerResult
		if (conf.triggerOnHeaders) {
			parser.on('headers', headers => {
				triggerResult = Promise.resolve().then(() => conf.trigger({ headers }))
				triggerResult.then(result => {
					if (result) {
						debug('Triggered (on headers)', { result, subject: headers.subject })
					} else {
						debug('Not triggered (on headers)', { result, subject: headers.subject })
						debug('Not triggered: Immediately interrupt parsing')
						messageStream.pause()
						parser.end()
					}
					return result
				})
			})
		}

		// Once mail is ready and parsed…
		parser.on('end', mail => {
			// …keep track of latest mail received…
			const date = new Date(mail.receivedDate)
			if (date > latestDate) {
				latestDate = date
			}
			// …check if it should trigger handler…
			if (!conf.triggerOnHeaders) {
				triggerResult = Promise.resolve().then(() => conf.trigger(mail))
				triggerResult.then(result => {
					if (result) {
						debug('Triggered (on end)', { result, subject: message.headers.subject })
					} else {
						debug('Not triggered (on end)', { result, subject: message.headers.subject })
					}
				})
			}
			// …and handle it if applicable
			triggerResult
			.then(result => result && handleMail(mail, result))
			.catch(handleError('TRIGGER'))
		})

		// Stream mail once ready
		message.once('body', stream => {
			messageStream = stream
			stream.pipe(parser)
		})
	}

	// Public bot API
	return {

		start () {
			debug('Connecting…')
			client = imap(conf.imap) // Create new client to handle restart when 'imap' content changes
			client.connect()
			return new Promise((resolve, reject) => {
				const onReady = () => {
					debug('Connected!')
					client.removeListener('error', onError)
					resolve()
				}
				const onError = err => {
					debug('Connection error!', err)
					client.removeListener('ready', onReady)
					reject(err)
				}
				client.once('ready', onReady)
				client.once('error', onError)
			})
		},

		stop (destroy = false) {
			debug('Stopping (' + (destroy ? 'BRUTAL' : 'graceful') + ')…')
			if (destroy) {
				console.warn('destroy() should be used with high caution! Use graceful stop to remove this warning and avoid losing data.') // eslint-disable-line no-console
			}
			client[destroy ? 'destroy' : 'end']()
			return new Promise((resolve, reject) => {
				const onEnd = () => {
					debug('Stopped!')
					client.removeListener('error', onError)
					resolve()
				}
				const onError = err => {
					debug('Stop error!', err)
					client.removeListener('end', onEnd)
					reject(err)
				}
				client.once('end', onEnd)
				client.once('error', onError)
			})
		},

		restart (destroy = false) {
			return this.stop(destroy).then(() => this.start())
		},

		configure (option, value, autoRestart = true, destroy = false) {
			conf[option] = value
			if (autoRestart && (option === 'imap' || option === 'mailbox' || option === 'filter')) {
				return this.restart(destroy)
			}
			return Promise.resolve()
		},

	}
}


// Helper: extract signature from text body

const extractSignature = (text) => talon.signature.bruteforce.extractSignature(text)


// Helper: parse addresses (needed when working with triggerOnHeaders)

const parseAddresses = (headers, { quiet = false } = {}) => {
	_parseAddressHeader(headers, 'to', quiet)
	_parseAddressHeader(headers, 'cc', quiet)
	_parseAddressHeader(headers, 'bcc', quiet)
	return headers
}

const _parseAddressHeader = (headers, field, quiet = false) => {
	let addresses = headers[field]
	if (typeof addresses === 'string') {
		addresses = [addresses]
	} else if (!addresses) {
		addresses = []
	}
	headers[field] = addresses.map(address => _parseAddressValue(address, quiet))
}

const _parseAddressValue = (value, quiet = false) => {
	let parsed
	try {
		parsed = address.parse(value)[0]
	} catch (err) {
		debug('Error parsing address', value, err)
		if (quiet) {
			parsed = {}
		} else {
			throw err
		}
	}
	parsed.raw = value
	return parsed
}


// Public API

module.exports = {
	createBot,
	parseAddresses,
	extractSignature,
}