#! /usr/bin/env node

var util = require('util');
var path = require('path');
var program = require('commander');
var R = require('ramda');
var bunyan = require('bunyan');
const bformat = require('bunyan-format');
const is = require('is_js');
var replicator = require('./../lib/replicator');
var utils = require('./../lib/utils');

const formatOut = bformat({ outputMode: 'long' });

const logger = bunyan.createLogger({
	name: 'slate-replicator',
	stream: formatOut,
	serializers: bunyan.stdSerializers
});

const exit = exitCode => setTimeout(_ => process.exit(exitCode), 1000);

process.on('uncaughtException', err => {
	logger.error({err: err}, `Uncaught exception:`);
	exit(1);
});
process.on('unhandledRejection', (reason, p) => {
	logger.error("Unhandled Rejection at: Promise ", p, " reason: ", reason);
	exit(1);
});
const handleSignal = signal => process.on(signal, _ => {
	logger.info(`${signal} received.`);
	exit(0);
});
R.forEach(handleSignal, ['SIGINT', 'SIGTERM']);

program
	.option('-c, --config-filename <s>', 'configuration file name')
	.option('--dry-run', 'if specified, display run parameters and end program without starting replicator')
	.parse(process.argv);

const validateArguments = arguments => {
	var errors = [];
	if (!arguments.configFilename || is.not.string(arguments.configFilename))
		errors = R.append('config-filename is invalid:  ' + JSON.stringify(arguments.configFilename), errors);
	if (!(arguments.dryRun === undefined || arguments.dryRun === true))
		errors = R.append('dry-run is invalid:  ' + JSON.stringify(arguments.dryRun), errors);
	if (arguments.args.length > 0)
		errors = R.append(`Some command arguments exist after processing command options.  There may be command options after " -- " in the command line.  Unprocessed Command Arguments:  ${JSON.stringify(program.args)}`, errors);
	return errors;
};

const createHostDatabaseName = (host, databaseName) => `${host.toLowerCase()}_${databaseName.toLowerCase()}`;

const validateReplicationDestinations = (replicationDestinations, eventSource, allErrors) => {
	// one replicationDestination must exist in the replicationDestinations object array
	// replicationDestination host-database combinations must be unique
	// no replicationDestination host-database combination can match the eventSource host-database combination
	if (is.array(replicationDestinations)) {
		if (replicationDestinations.length > 0) {
			var destinations = [];
			var destinationErrors = [];
			R.forEach((replicationDestination, i) => {
				const connectionErrors = utils.validateConnectionParameters(replicationDestination, `config.replicationDestinations[${i}]`);
				if (connectionErrors.length === 0) {
					const destination = createHostDatabaseName(replicationDestination.host, replicationDestination.databaseName);
					if (R.contains(destination, destinations)) {
						allErrors = R.append('duplicate config.replicationDestinations host - databaseName combination detected at replicationDestination[' + i + ']' +
							'    host:  ' + replicationDestination.host + '   databaseName:  ' + replicationDestination.databaseName, allErrors);
					}
					else {
						destinations = R.append(destination, destinations);
					}
				}
				else {
					destinationErrors = R.concat(connectionErrors, destinationErrors);
				}
			}, replicationDestinations);
			if (eventSource.host && eventSource.databaseName) {
				if (R.contains(createHostDatabaseName(eventSource.host, eventSource.databaseName), destinations)) {
					allErrors = R.append('config.eventSource host - databaseName combination matches a config.replicationDestination host - databaseName combination' +
						' --  host:  ' + eventSource.host + '   databaseName:  ' + eventSource.databaseName, allErrors);
				}
			}
			allErrors = R.concat(destinationErrors, allErrors);
		}
		else {
			allErrors = R.append('config.replicationDestinations has no elements', allErrors);
		}
	}
	else {
		allErrors = R.append('config.replicationDestinations is not an Array or missing:  ' + replicationDestinations, allErrors);
	}
	return allErrors;
};

const validateConfigParameters = config => {
	var allErrors = [];
	var eventSource = {};
	// optional parameter
	config.maxEventsPerWrite = config.maxEventsPerWrite || 10000;
	if (utils.isPositiveInteger(config.maxEventsPerWrite)) {
		if (config.maxEventsPerWrite < 10000) {
			config.maxEventsPerWrite = 10000;
			logger.info(`config.maxEventsPerWrite set to minimum value of 10000`);
		}
	}
	else {
		allErrors = R.append('config.maxEventsPerWrite is not a positive integer:  ' + config.maxEventsPerWrite, allErrors);
	}
	if (config.connectTimeout) {
		if (!utils.isPositiveInteger(config.connectTimeout)) {
			allErrors = R.append(`config.connectTimeout is invalid:  ${config.connectTimeout}`, allErrors);
		}
	}
	const connectionErrors = utils.validateConnectionParameters(config.eventSource, 'config.eventSource');
	if (connectionErrors.length > 0) {
		allErrors = R.concat(connectionErrors, allErrors);
	}
	else {
		eventSource = R.pick(['host', 'databaseName'], config.eventSource);
	}
	allErrors = validateReplicationDestinations(config.replicationDestinations, eventSource, allErrors);
	return allErrors;
};

const logConfig = config => {
	logger.info(`Event Source:  `, R.pick(['host', 'databaseName', 'user', 'connectTimeout'], config.eventSource));
	logger.info(`Replication Destinations:`);
	R.forEach(replicationDestination => logger.info(`  Destination:  `, R.pick(['host', 'databaseName', 'user', 'connectTimeout'], replicationDestination)), config.replicationDestinations);
	if (config.maxEventsPerWrite)
		logger.info(`Maximum Events Per Write:`, config.maxEventsPerWrite);
	if (config.connectTimeout)
		logger.info(`Database Connection Timeout (millisecs):`, config.connectTimeout);
	logger.info('\n');
};
/////////////////////////////////////////////////////////////////////////////////////
//  validate configuration
/////////////////////////////////////////////////////////////////////////////////////
const argumentErrors = validateArguments(program);
if (argumentErrors.length > 0) {
	logger.error(`Invalid command line arguments:${'\n' + R.join('\n', argumentErrors)}`);
	program.help();
	process.exit(2);
}
// get absolute name so logs will display absolute path
const configFilename = path.isAbsolute(program.configFilename) ? program.configFilename : path.resolve('.', program.configFilename);

let config;
try {
	logger.info(`Config File Name:  "${configFilename}"`);
	config = require(configFilename);
}
catch(err) {
	logger.error({err: err}, `Exception detected processing configuration file:`);
	process.exit(1);
}

const configErrors = validateConfigParameters(config);
if (configErrors.length > 0) {
	logger.error(`Invalid configuration parameters:${'\n' + R.join('\n', configErrors)}`);
	program.help();
	process.exit(2);
}

logConfig(config);

if (program.dryRun) {
	logger.info(`--dry-run specified, ending program`);
	process.exit(2);
}
/////////////////////////////////////////////////////////////////////////////////////
//  to reach this point, configuration must be valid and --dry-run was not specified
/////////////////////////////////////////////////////////////////////////////////////
replicator(config.eventSource, config.replicationDestinations, logger, config.maxEventsPerWrite, config.connectTimeout)
.then(() =>  {
	logger.info(`Processing started`);
})
.catch(err => {
	logger.error({err: err}, `Exception in replicator:`);
	exit(1);
});
