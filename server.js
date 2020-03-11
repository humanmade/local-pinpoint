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
const { resolve, basename } = require( 'path' );
const { inspect, promisify } = require( 'util' );
const readFile = promisify( fs.readFile );
const writeFile = promisify( fs.writeFile );
const { format } = require( 'date-fns' );

// Make endpoints directory if it doesn't exist.
fs.access( resolve( __dirname, 'endpoints' ), fs.constants.W_OK, err => {
	if ( err ) {
		fs.mkdir( resolve( __dirname, 'endpoints' ), () => {} );
	}
} );

const getIndexName = () => {
	const date = new Date();
	const indexRotation = process.env.INDEX_ROTATION || 'NoRotation';
	const indexBase = 'analytics';
	switch ( indexRotation ) {
		case 'OneMonth':
			return `${ indexBase }-${ format( date, "yyyy-MM" ) }`;
		case 'OneWeek':
			return `${ indexBase }-${ format( date, "yyyy-'w'ww" ) }`;
		case 'OneDay':
			return `${ indexBase }-${ format( date, "yyyy-MM-dd" ) }`;
		case 'OneHour':
			return `${ indexBase }-${ format( date, "yyyy-MM-dd-HH" ) }`;
		case 'NoRotation':
		default:
			return indexBase;
	}
}

const uuid = placeholder =>
	placeholder
		? ( placeholder ^ ( ( Math.random() * 16 ) >> ( placeholder / 4 ) ) ).toString( 16 )
		: ( [ 1e7 ] + -1e3 + -4e3 + -8e3 + -1e11 ).replace( /[018]/g, uuid );

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
				code: endpoint.Demographic.Locale || '',
				country: ( endpoint.Demographic.Location.Country || '' )
					.toUpperCase(),
				language: ( endpoint.Demographic.Locale || '' )
					.replace( /^([a-z]{1,3})-[a-z]{1,3}/i, '$1' )
					.toLowerCase(),
			},
			model: endpoint.Demographic.Model || '',
			make: endpoint.Demographic.Make || '',
			platform: {
				name: ( endpoint.Demographic.Platform || '' ).toLowerCase(),
				version: endpoint.Demographic.PlatformVersion || ''
			},
		},
		endpoint: endpoint || {},
		event_type: event.EventType || '',
		event_timestamp: new Date( event.Timestamp ).getTime(),
		event_version: '',
		session: session,
	};
};

const esRequest = async ( path, data, method = 'PUT' ) => {
	try {
		const rsp = await rp( {
			uri: `${ process.env.ELASTICSEARCH_HOST || 'http://elasticsearch:9200' }/${ path }`,
			body: data,
			json: true,
			method: method,
		} );
		return rsp;
	} catch ( err ) {
		console.error( inspect( err.error, {
			showHidden: false,
			depth: null,
		} ) );
		return err.error;
	}
}

const putMapping = async () => {
	// Put the mapping.
	const mapping = await readFile( `${__dirname}/mapping.json` );
	return await esRequest( getIndexName(), JSON.parse( mapping ) );
}

const addRecord = async data => {
	return await esRequest( `${ getIndexName() }/record/`, data, 'POST' );
}

const setEndpoint = async ( data, id ) => {
	try {
		await writeFile( resolve( __dirname, `endpoints/${id}.json` ), JSON.stringify( data ) );
		return true;
	} catch ( err ) {
		console.error( 'could not write endpoint.json', err );
		return false;
	}
}

const getEndpoint = async id => {
	try {
		const endpoint = await readFile( resolve( __dirname, `endpoints/${id}.json` ) );
		return JSON.parse( endpoint );
	} catch ( err ) {
		console.error( 'could not read endpoint.json', err );
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
			const storedEndpoint = await getEndpoint( cid );
			const { Events, Endpoint } = item;
			const finalEndpoint = Object.assign( {}, storedEndpoint, Endpoint );
			Object.entries( Events ).forEach( async ( [ eid, event ] ) => {
				console.log( 'batch event', event, finalEndpoint );
				await addRecord( makeRecord( req.params.app, event, finalEndpoint ) );
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
		const body = await json( req );

		if ( ! body.Attributes ) {
			send( res, 500 );
			return;
		}

		// Fill in any gaps as Pinpoint does.
		body.Id = req.params.endpoint;
		body.ApplicationId = req.params.app;
		body.CreationDate = new Date().toISOString();

		await putMapping();
		await setEndpoint( body, req.params.endpoint );

		setHeaders( req, res );
		send( res, 202, {
			Message: 'Accepted',
			RequestID: res.getHeader( 'x-amzn-requestid' ),
		} );
		return;
	} )
);
