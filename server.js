const { send, json } = require( 'micro' );
const {
	router,
	options,
	post,
	put,
	get,
} = require( 'micro-fork' );
const rp = require( 'request-promise' );
const fs = require( 'fs' );
const { resolve } = require( 'path' );
const { inspect, promisify } = require( 'util' );
const appendFile = promisify( fs.appendFile );
const readFile = promisify( fs.readFile );
const writeFile = promisify( fs.writeFile );
const { format } = require( 'date-fns' );
const merge = require( 'deepmerge' );

// Make endpoints & logs directories if they don't exist.
fs.access( resolve( __dirname, 'endpoints' ), fs.constants.W_OK, err => {
	if ( err ) {
		fs.mkdir( resolve( __dirname, 'endpoints' ), () => {} );
	}
} );
fs.access( resolve( __dirname, 'logs' ), fs.constants.W_OK, err => {
	if ( err ) {
		fs.mkdir( resolve( __dirname, 'logs' ), () => {} );
	}
} );

const getIndexName = () => {
	const date = new Date();
	const indexRotation = process.env.INDEX_ROTATION || 'NoRotation';
	const indexBase = 'analytics';
	switch ( indexRotation ) {
		case 'OneMonth':
			return `${ indexBase }-${ format( date, 'yyyy-MM' ) }`;
		case 'OneWeek':
			return `${ indexBase }-${ format( date, 'yyyy-ww' ) }`;
		case 'OneDay':
			return `${ indexBase }-${ format( date, 'yyyy-MM-dd' ) }`;
		case 'OneHour':
			return `${ indexBase }-${ format( date, 'yyyy-MM-dd-HH' ) }`;
		case 'NoRotation':
		default:
			return indexBase;
	}
}

const uuid = placeholder =>
	placeholder
		? ( placeholder ^ ( ( Math.random() * 16 ) >> ( placeholder / 4 ) ) ).toString( 16 )
		: ( [ 1e7 ] + -1e3 + -4e3 + -8e3 + -1e11 ).replace( /[018]/g, uuid );

const overwriteMerge = ( destinationArray, sourceArray ) => sourceArray;

const setHeaders = ( req, res, headers = {} ) => {
	res.setHeader( 'access-control-allow-origin', '*' );
	if ( req.headers['access-control-request-headers'] ) {
		res.setHeader( 'access-control-allow-headers', req.headers['access-control-request-headers'] );
	}
	res.setHeader( 'access-control-expose-headers', 'x-amzn-RequestId,x-amzn-ErrorType,x-amzn-ErrorMessage,Date' );
	res.setHeader( 'access-control-allow-methods', req.headers['access-control-allow-methods'] || 'GET, PUT, POST, DELETE, HEAD, OPTIONS' );
	res.setHeader( 'access-control-max-age', '172800' );
	res.setHeader( 'date', new Date().toUTCString() );
	res.setHeader( 'x-amzn-requestid', uuid() );
	Object.entries( headers, ( [ key, value ] ) => {
		res.setHeader( key, value );
	} );
}

const makeRecord = ( appId, event, endpoint ) => {
	const session = {
		session_id: event.Session.Id,
		start_timestamp: new Date( event.Session.StartTimestamp ).getTime(),
	};
	if ( event.Session.Duration && event.Session.StopTimestamp ) {
		session.duration = event.Session.Duration;
		session.stop_timestamp = new Date( event.Session.StopTimestamp ).getTime();
	}
	const {
		Locale = '',
		Location = {},
		Make = '',
		Model = '',
		Platform = '',
		PlatformVersion = '',
	} = endpoint.Demographic || {};
	return {
		application: {
			app_id: appId,
			cognito_identity_pool_id: 'local',
			version_name: event.AppVersionCode || '',
		},
		arrival_timestamp: Date.now(),
		attributes: event.Attributes || {},
		metrics: event.Metrics || {},
		client: {
			client_id: endpoint.Id || '',
			cognito_id: `local:${ endpoint.Id || '' }`,
		},
		device: {
			locale: {
				code: Locale || '',
				country: ( Location.Country || '' ).toUpperCase(),
				language: ( Locale || '' )
					.replace( /^([a-z]{1,3})-[a-z]{1,3}/i, '$1' )
					.toLowerCase(),
			},
			model: Model || '',
			make: Make || '',
			platform: {
				name: ( Platform || '' ).toLowerCase(),
				version: PlatformVersion || '',
			},
		},
		endpoint: endpoint || {},
		event_type: event.EventType || '',
		event_timestamp: new Date( event.Timestamp ).getTime(),
		event_version: '',
		session: session,
	};
};

const writeLog = async ( filename, row ) => {
	await appendFile( resolve( __dirname, `logs/${filename}` ), `${row.toString()}\n` );
}

const esRequest = async ( path, data, method = 'PUT', log = false ) => {
	try {
		const rsp = await rp( {
			uri: `${ process.env.ELASTICSEARCH_HOST || 'http://elasticsearch:9200' }/${ path }`,
			body: data,
			json: true,
			method: method,
		} );
		return rsp;
	} catch ( err ) {
		if ( log ) {
			console.error( inspect( err.error, {
				showHidden: false,
				depth: null,
			} ) );
		}
		return err.error;
	}
}

const putMapping = async () => {
	// Put the mapping.
	const mapping = await readFile( `${__dirname}/mapping.json` );
	return await esRequest( getIndexName(), JSON.parse( mapping ) );
}

const addRecord = async data => {
	if ( process.env.LOG_EVENTS ) {
		await writeLog( 'events.log', JSON.stringify( data ) );
	}
	return await esRequest( `${ getIndexName() }/_doc/`, data, 'POST', true );
}

const setEndpoint = async ( id, data ) => {
	try {
		// Set the updated date.
		data.EffectiveDate = new Date().toISOString();

		// Check endpoint exists.
		const endpoint = await getEndpoint( id );
		if ( ! endpoint.Id ) {
			data.Id = id;
			data.CreationDate = new Date().toISOString();
			data.CohortId = Math.floor( Math.random() * 100 );
		} else {
			// Merge endpoint data in.
			data = merge( endpoint, data, {
				arrayMerge: overwriteMerge,
			} );
		}
		await writeFile( resolve( __dirname, `endpoints/${id}.json` ), JSON.stringify( data ) );
		return true;
	} catch ( err ) {
		console.error( 'could not write endpoint.json', err );
		return false;
	}
}

const getEndpoint = async ( id, log = false ) => {
	try {
		const endpoint = await readFile( resolve( __dirname, `endpoints/${id}.json` ) );
		return JSON.parse( endpoint );
	} catch ( err ) {
		if ( log ) {
			console.error( 'could not read endpoint.json', err );
		}
		return {};
	}
}

module.exports = router()(
	get( '/*', ( req, res ) => send( res, 200, {
		message: 'Service is running',
	} ) ),
	// Legacy endpoint
	options( '/v1/apps/:app/:route(events|legacy)', ( req, res ) => {
		setHeaders( req, res );
		send( res, 200 );
	} ),
	post( '/v1/apps/:app/:route(events|legacy)', async ( req, res ) => {
		const body = await json( req );

		if ( ! body.BatchItem ) {
			send( res, 500 );
			return;
		}

		await putMapping();

		Object.entries( body.BatchItem ).forEach( async ( [ cid, item ] ) => {
			const { Events, Endpoint } = item;
			// Update the endpoint.
			Endpoint.ApplicationId = req.params.app;
			await setEndpoint( cid, Endpoint );
			const endpoint = await getEndpoint( cid, true );
			Object.entries( Events ).forEach( async ( [ eid, event ] ) => {
				console.log( 'batch event', eid, event, endpoint );
				await addRecord( makeRecord( req.params.app, event, endpoint ) );
			} );
		} );

		setHeaders( req, res );
		send( res, 202, {
			Results: Object
				.entries( body.BatchItem )
				.reduce( ( carry, [ key, batch ] ) => ( {
					[key]: {
						EndpointItemResponse: {
							StatusCode: 202,
							Message: 'Accepted',
						},
						EventsItemResponse: Object
							.keys( batch.Events )
							.reduce( ( carry2, id ) => ( {
								[id]: {
									StatusCode: 202,
									Message: 'Accepted',
								},
								...carry2,
							} ), {} ),
					},
					...carry,
				} ), {} ),
		} );
	} ),
	// Update endpoint
	options( '/v1/apps/:app/endpoints/:endpoint', ( req, res ) => {
		setHeaders( req, res );
		send( res, 200 );
	} ),
	put( '/v1/apps/:app/endpoints/:endpoint', async ( req, res ) => {
		let body = await json( req );

		if ( ! body.Attributes ) {
			send( res, 500 );
			return;
		}

		body.Id = req.params.endpoint;
		body.ApplicationId = req.params.app;

		await setEndpoint( req.params.endpoint, body );

		setHeaders( req, res );
		send( res, 202, {
			Message: 'Accepted',
			RequestID: res.getHeader( 'x-amzn-requestid' ),
		} );
		return;
	} )
);
