'use strict';
const adapterName = require('./io-package.json').common.name;
const utils = require('@iobroker/adapter-core'); // Get common adapter utils

const _request = require('request-promise');


/*
 * internal libraries
 */
const Library = require(__dirname + '/lib/library.js');
const _NODES = require(__dirname + '/_NODES.js');
const _SUBSCRIPTIONS = require(__dirname + '/_SUBSCRIPTIONS.js');


/*
 * variables initiation
 */
let adapter;
let library;
let unloaded;
let dutyCycle, refreshCycle;

let bridge, device;
let DEVICES = {
	'groups': {},
	'lights': {},
	'resourcelinks': {},
	'rules': {},
	'scenes': {},
	'schedules': {},
	'sensors': {}
};


/*
 * ADAPTER
 *
 */
function startAdapter(options)
{
	options = options || {};
	Object.assign(options,
	{
		name: adapterName
	});
	
	adapter = new utils.Adapter(options);
	library = new Library(adapter);
	unloaded = false;
	
	/*
	 * ADAPTER READY
	 *
	 */
	adapter.on('ready', function()
	{
		if (!adapter.config.bridgeIp || !adapter.config.bridgeUser)
			return library.terminate('Please provide connection settings for Hue Bridge!');
		
		// Bridge connection
		bridge = 'http://' + adapter.config.bridgeIp + ':' + (adapter.config.bridgePort || 80) + '/api/' + adapter.config.bridgeUser + '/';
		
		// retrieve from Bridge
		['config', 'groups', 'lights', 'resourcelinks', 'rules', 'scenes', 'schedules', 'sensors'].forEach(function(channel)
		{
			if (adapter.config['sync' + library.ucFirst(channel)])
				getBridgeData(channel, adapter.config.refresh || 0);
		});
		
		// delete old states (which were not updated recently)
		clearTimeout(dutyCycle);
		dutyCycle = setTimeout(function dutyCycleRun()
		{
			adapter.log.debug('Running Duty Cycle...');
			library.runDutyCycle(adapterName + '.' + adapter.instance, Math.floor(Date.now()/1000));
			adapter.log.debug('Duty Cycle finished.');
			dutyCycle = setTimeout(dutyCycleRun, 4*60*60*1000);
			
		}, 60*1000);
	});

	/*
	 * STATE CHANGE
	 *
	 */
	adapter.on('stateChange', function(id, state)
	{
		if (state === undefined || state === null || state.ack === true || state.val === undefined || state.val === null) return;
		adapter.log.debug('State of ' + id + ' has changed ' + JSON.stringify(state) + '.');
		
		// get params
		let params = id.replace(adapterName + '.' + adapter.instance + '.', '').split('.');
		let type = params.splice(0,1);
		let deviceId = type == 'scenes' ? params.splice(0,2) : params.splice(0,1);
		
		// get device data
		let name = getDeviceState([...type, ...deviceId, 'name']);
		let uid = getDeviceState([...type, ...deviceId, 'uid']);
		let path = type + '/' + uid + '/' + (type == 'groups' ? 'action' : 'state');
		let action = params[params.length-1];
		
		if (!uid)
			return false;
		
		// reset if scene was set
		if (id.indexOf('.scene') > -1)
			library._setValue(id, '');
		
		// build command
		let service = { name: name, trigger: path };
		let commands = { [action]: state.val };
		
		// handle sccene
		if (type == 'scenes')
		{
			let scene = deviceId[1].substr(0, deviceId[1].indexOf('_')).split('-');
			service.trigger = scene[0] == 'GroupScene' ? 'groups/' + scene[1] + '/action' : 'lights/' + scene[1] + '/state';
			service.name = scene.join(' ');
			commands = { 'scene': uid };
		}
		
		// if device is turned on, make sure brightness is not 0
		if (action == 'on' && state.val == true)
		{
			let bri = getDeviceState([type, deviceId, 'state.bri']) || getDeviceState([type, deviceId, 'action.bri']);
			commands.bri = bri == 0 ? 254 : bri;
		}
		
		// if device is turned off, set level / bri to 0
		/*
		if (action == 'on' && state.val == false)
			commands.bri = 0;
		*/
		
		// if .hue_degrees is changed, change hue
		if (action == 'hue_degrees')
			commands = { hue: Math.round(state.val / 360 * 65535) };
		
		// if .level is changed the change will be applied to .bri instead
		if (action == 'level')
			commands = { on: true, bri: Math.ceil(254 * state.val / 100) };
		
		// if .bri is changed, make sure light is on
		if (action == 'bri')
			commands = { on: true, bri: state.val };
		
		// if .bri is changed to 0, turn off
		if ((action == 'bri' || action == 'level') && state.val < 1)
			commands = { on: false, bri: 0 };
		
		// check reachability
		if (type == 'lights' && !getDeviceState([type, deviceId, 'state.reachable']))
			adapter.log.warn('Device ' + name + ' does not seem to be reachable! Command is sent anyway.');
		
		// apply command
		Object.keys(commands).forEach(command => setDeviceState([type, deviceId, command], '')); // reset stored states so that retrieved states will renew
		sendCommand(service, commands);
	});
	
	/*
	 * ADAPTER UNLOAD
	 *
	 */
	adapter.on('unload', function(callback)
	{
		try
		{
			adapter.log.info('Adapter stopped und unloaded.');
			
			unloaded = true;
			DEVICES = undefined;
			clearTimeout(refreshCycle);
			clearTimeout(dutyCycle);
			
			callback();
		}
		catch(e)
		{
			callback();
		}
	});

	return adapter;	
};


/*
 * COMPACT MODE
 * If started as allInOne/compact mode => returnfunction to create instance
 *
 */
if (module && module.parent)
	module.exports = startAdapter;
else
	startAdapter(); // or start the instance directly


/**
 *
 */
function getBridgeData(channel, refresh)
{
	//adapter.log.debug('Retrieving ' + channel + ' from Hue Bridge...');
	_request({ uri: bridge + channel + '/', json: true }).then(function(res)
	{
		if (!res || (res[0] && res[0].error))
		{
			adapter.log.error('Error retrieving ' + channel + ' from Hue Bridge' + (res[0] && res[0].error ? ': ' + res[0].error.description : '!'));
			return false;
		}
		
		// add meta data
		res.timestamp = Math.floor(Date.now()/1000);
		res.datetime = library.getDateTime(Date.now());
		
		// write data to states
		addBridgeData({ [channel]: res });
		
		// refresh interval
		if (refresh > 0 && refresh < 10)
		{
			adapter.log.warn('Due to performance reasons, the refresh rate can not be set to less than 10 seconds. Using 10 seconds now.');
			refresh = 10;
		}
		
		if (refresh > 0 && !unloaded)
			refreshCycle = setTimeout(getBridgeData, refresh*1000, channel, refresh);
		
	}).catch(function(err)
	{
		if (err.message.substr(0, 3) == 500)
		{
			adapter.log.warn('Error: Hue Bridge is busy. Try again in 10s..');
			adapter.log.debug(err.message);
			setTimeout(getBridgeData, 10*1000, channel, refresh);
		}
		else
		{
			adapter.log.warn('Error connecting to Hue Bridge when retrieving channel ' + channel + '! See debug log for details.');
			adapter.log.debug(err.message);
			adapter.log.debug(err.stack);
		}
	});
}

/**
 *
 */
function addBridgeData(data)
{
	//adapter.log.debug('Refreshing ' + Object.keys(data) + ' (' + JSON.stringify(data) + ').');
	
	// add meta data
	data.timestamp = Math.floor(Date.now()/1000);
	data.datetime = library.getDateTime(Date.now());
	
	for (let key in data)
	{
		// loop through payload
		device = null;
		readData(key, data[key]);
	}
}

/**
 *
 */
function readData(key, data)
{
	// only proceed if data is given
	if (data === undefined || data === 'undefined')
		return false;
	
	// set current device name
	if (data && data.name)
		device = data.name;
	
	// get node details
	key = key.replace(/ /g, '_');
	let node = get(key.split('.')); // lights.<NAME/ID>.folder
	
	// loop nested data
	if (data !== null && typeof data == 'object' && key.substr(-2) != 'xy')
	{
		// create channel
		if (Object.keys(data).length > 0)
		{
			// use uid and name instead of only uid
			let id = false;
			if (data.name && key.indexOf('config') == -1)
			{
				data.uid = key.substr(key.lastIndexOf('.')+1);
				id = data.name.toLowerCase().replace(/ /g, '_');
				key = key.indexOf('scenes') == -1 ?
					key.replace('.' + data.uid, '.' + data.uid + '-' + id) :
					key.replace('.' + data.uid, '.' + id);
			}
			
			// add level as additional state
			if (data.bri !== undefined)
			{
				data.level = data.bri > 0 ? Math.ceil(data.bri / 254 * 100) : 0;
				data.transitiontime = data.transitiontime || 4;
				data.scene = '';
			}
			
			// add hue degree as additional state
			if (data.hue !== undefined)
				data.hue_degrees = Math.round(data.hue / 65535 * 360);
			
			// add scene trigger button as additional state (only to scenes)
			if (data.type == 'GroupScene' || data.type == 'LightScene')
				data.action = { trigger: false };
			
			// create channel
			library.set({
				node: key,
				role: 'channel',
				description: id || RegExp('\.[0-9]{1-3}$').test(key.substr(-4)) ? data.name : library.ucFirst(key.substr(key.lastIndexOf('.')+1))
			});
			
			// read nested data
			for (let nestedKey in data)
			{
				let pathKey = '';
				
				// create sub channel for scenes
				if (key.indexOf('scenes') > -1 && ((data.type == 'GroupScene' && data.group) || (data.type == 'LightScene' && data.lights && data.lights[0])))
				{
					pathKey = '.' + data.type + '-' + (data.group || data.lights[0]) + '_' + data.uid;
					library.set({
						node: key + pathKey,
						role: 'channel',
						description: data.type + ' ' + (data.group || data.lights[0])
					});
				}
				
				readData(key + pathKey + '.' + nestedKey, data[nestedKey]);
			}
		}
	}
	
	// write to states
	else
	{
		// convert data
		node.key = key;
		data = convertNode(node, data);
		
		// get device from cache
		let val = getDeviceState(key.split('.'));
		let action = key.substr(key.lastIndexOf('.')+1);
		
		if (val === null)
		{
			// index device
			setDeviceState(key.split('.'), data);
			
			// remap state to action
			if (_SUBSCRIPTIONS.indexOf(action) > -1 && key.indexOf('state.' + action) > -1)
			{
				key = key.replace('.state.', '.action.');
				library.set({
					node: key.substr(0, key.indexOf('.action.')+7),
					role: 'channel',
					description: 'Action'
				});
			}
			
			// set state
			library.set(
				{
					node: key,
					type: node.type,
					role: node.role,
					description: (node.device !== false && device ? device + ' - ' : '') + (node.description || library.ucFirst(key.substr(key.lastIndexOf('.')+1))),
					common: Object.assign(
						node.common || {},
						{
							write: (_SUBSCRIPTIONS.indexOf(action) > -1 && key.indexOf('action.' + action) > -1)
						}
					)
				},
				data
			);
			
			// subscribe to states
			if (_SUBSCRIPTIONS.indexOf(action) > -1 && key.indexOf('action.' + action) > -1)
			{
				node.subscribe = true;
				adapter.subscribeStates(key);
			}
		}
		
		// set state (if value differs)
		else if (val != data)
		{
			if (['timestamp', 'datetime', 'UTC', 'localtime', 'last_use_date'].indexOf(key.substr(key.lastIndexOf('.')+1)) == -1)
				adapter.log.debug('Received updated value for ' + key + ': '+JSON.stringify(data));
			
			// remap
			if (_SUBSCRIPTIONS.indexOf(action) > -1 && key.indexOf('state.' + action) > -1)
				key = key.replace('.state.', '.action.');
			
			// update state value
			adapter.setState(key, { val: data, ts: Date.now(), ack: true });
			setDeviceState(key.split('.'), data);
		}
	}
}

/**
 *
 */
function convertNode(node, data)
{
	switch(node.convert)
	{
		case "string":
			data = JSON.stringify(data);
			break;
			
		case "temperature":
			data = data / 100;
			break;
			
		/*
		case "date-timestamp":
			
			// convert timestamp to date
			let date;
			if (data.toString().indexOf('-') > -1)
			{
				date = data
				data = Math.floor(new Date(data).getTime()/1000)
			}
			
			// or keep date if that is given
			else
			{
				let ts = new Date(data*1000);
				date = ts.getFullYear() + '-' + ('0'+ts.getMonth()).substr(-2) + '-' + ('0'+ts.getDate()).substr(-2);
			}
			
			// set date
			library.set(
				{
					node: node.key + 'Date',
					type: 'string',
					role: 'text',
					description: node.description.replace('Timestamp', 'Date')
				},
				date
			);
			break;
		
		case "ms-min":
			let duration = data/1000/60;
			return duration < 1 ? data : Math.floor(duration);
			break;
		*/
	}
	
	return data;
}

/**
 *
 */
function get(node)
{
	if (node[1] == 'timestamp' || node[1] == 'datetime') node[0] = node[1];
	node.splice(1,1);
	
	return _NODES[library.clean(node[node.length-1], true)] || _NODES[library.clean(node.join('.'), true)] || { description: '', role: 'text', type: 'string', convert: null };
}

/**
 *
 */
function getDeviceState([type, name, ...params])
{
	return DEVICES[type] !== undefined && DEVICES[type][name] !== undefined && DEVICES[type][name][params.join('.')] !== undefined ? DEVICES[type][name][params.join('.')] : null;
}

/**
 *
 */
function setDeviceState([type, name, ...params], value)
{
	if (!DEVICES[type]) DEVICES[type] = {};
	if (!DEVICES[type][name]) DEVICES[type][name] = {};
	DEVICES[type][name][params.join('.')] = value;
}

/**
 *
 */
function sendCommand(device, actions)
{
	let options = {
		uri: bridge + device.trigger,
		method: 'PUT',
		json: true,
		body: actions.xy ? {"xy": JSON.parse(actions.xy)} : actions
	};
	
	adapter.log.debug('Send command to ' + device.name + ' (' + device.trigger + '): ' + JSON.stringify(actions) + '.');
	_request(options).then(function(res)
	{
		if (!Array.isArray(res))
		{
			adapter.log.warn('Unknown error applying actions ' + JSON.stringify(actions) + ' on ' + device.name + ' (to ' + device.trigger + ')!');
			adapter.log.debug('Response: ' + JSON.stringify(res));
		}
		
		else
		{
			let type;
			res.forEach(msg =>
			{
				type = Object.keys(msg);
				if (type == 'error')
					adapter.log.warn('Error setting ' + msg[type].address + ': ' + msg[type].description);
				else
					adapter.log.info('Successfully set ' + Object.keys(msg[type]) + ' on ' + device.name + ' (to ' + Object.values(msg[type]) + ').');
			});
		}
		
	}).catch(function(e)
	{
		adapter.log.warn('Failed sending request to ' + device.trigger + '!');
		adapter.log.debug('Error Message: ' + e);
	});
}
