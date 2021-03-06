/**
 * MHub server (mserver)
 *
 * Makes MHub pubsub Nodes available through WebSockets.
 */

import "source-map-support/register";

import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as path from "path";
import Promise from "ts-promise";
import * as ws from "ws";
import * as yargs from "yargs";

import { PlainAuthenticator } from "./authenticator";
import Hub, { UserRights } from "./hub";
import { LogLevel } from "./logger";
import * as pubsub from "./pubsub";
import * as storage from "./storage";
import { replaceKeyFiles, TlsOptions } from "./tls";
import TcpConnection from "./transports/tcpconnection";
import WSConnection from "./transports/wsconnection";
import { KeyValues } from "./types";

import log from "./log";

const DEFAULT_PORT_WS = 13900;
const DEFAULT_PORT_WSS = 13901;
const DEFAULT_PORT_TCP = 13902;

interface Binding {
	from: string;
	to: string;
	pattern?: string;
}

interface WSServerOptions extends TlsOptions {
	type: "websocket";
	port?: number; // default 13900 (ws) or 13901 (wss)
}

interface TcpServerOptions {
	type: "tcp";
	host?: string; // NodeJS default (note: will default to IPv6 if available!)
	port?: number; // default 13902
	backlog?: number; // NodeJS default, typically 511
}

interface NodeDefinition {
	type: string;
	options?: { [key: string]: any; };
}

interface NodesConfig {
	[nodeName: string]: string | NodeDefinition;
}

type ListenOptions = WSServerOptions | TcpServerOptions;

interface Config {
	listen?: ListenOptions | ListenOptions[];
	port?: number;
	verbose?: boolean;
	logging?: "none" | "fatal" | "error" | "warning" | "info" | "debug";
	bindings?: Binding[];
	nodes: string[] | NodesConfig;
	storage?: string;
	users?: string | { [username: string]: string };
	rights: UserRights;
}

// tslint:disable-next-line:no-shadowed-variable
function die(...args: any[]): void {
	log.fatal.apply(log, args);
	process.exit(1);
}

// Register known node types

import ConsoleDestination from "./nodes/consoleDestination";
import Exchange from "./nodes/exchange";
import PingResponder from "./nodes/pingResponder";
import Queue from "./nodes/queue";
import TestSource from "./nodes/testSource";
import TopicStore from "./nodes/topicStore";

interface ConstructableNode {
	new(name: string, options?: KeyValues<any>): pubsub.Source | pubsub.Destination;
}

const nodeClasses: ConstructableNode[] = [
	ConsoleDestination,
	Exchange,
	PingResponder,
	Queue,
	TestSource,
	TopicStore,
];

const nodeClassMap: { [className: string]: ConstructableNode } = {};
nodeClasses.forEach((c) => {
	nodeClassMap[(<any>c).name] = c;
});

// For backward compatibility
/* tslint:disable:no-string-literal */
nodeClassMap["TopicQueue"] = TopicStore;
nodeClassMap["TopicState"] = TopicStore;
/* tslint:enable:no-string-literal */

// Build list of valid log level names (e.g. none, fatal, error, ...)
const logLevelNames = Object.keys(LogLevel).filter((s) => !/\d+/.test(s)).map((s) => s.toLowerCase());

// Parse input arguments

const args = yargs
	.usage("mhub-server [-c <config_file>]")
	.help("help")
	.alias("h", "help")
	// tslint:disable-next-line:no-require-imports
	.version(() => require(path.resolve(__dirname, "../../package.json")).version)
	.alias("v", "version")
	.option("c", {
		type: "string",
		alias: "config",
		description: "Filename of config, uses mhub's server.conf.json by default",
	})
	.option("l", {
		type: "string",
		alias: "loglevel",
		description: "Override log level in config file. Valid options: " + logLevelNames.join(", "),
	})
	.strict()
	.argv;

// Parse config file

let configFile: string;
if (!args.config) {
	configFile = path.resolve(__dirname, "../../server.conf.json");
} else {
	configFile = path.resolve(args.config);
}

let config: Config;
try {
	config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (e) {
	throw die(`Cannot parse config file '${configFile}':`, e);
}

// Historically, verbose logging was the default.
// Then, the config.verbose option was introduced, again kept as the default.
// Now, we have the config.logging option which is more flexible and is used
// whenever available.
// This can then be overriden using the commandline.
const logLevelName = args.loglevel || config.logging;
if (config.logging) {
	// Convert config.logging to a LogLevel
	const found = Object.keys(LogLevel).some((s) => {
		if (s.toLowerCase() === logLevelName) {
			log.logLevel = (<any>LogLevel)[s] as LogLevel;
			return true;
		}
		return false;
	});
	if (!found) {
		die(`Invalid log level '${logLevelName}', expected one of: ${logLevelNames.join(", ")}`);
	}
} else if (config.verbose === undefined || config.verbose) {
	log.logLevel = LogLevel.Debug;
}

log.info("Using config file " + configFile);

// 'Normalize' config and convert paths to their contents
if (!config.nodes) {
	die("Invalid configuration: missing `nodes`");
}

if (config.port) {
	if (config.listen) {
		die("Invalid configuration: specify either `port` or `listen`");
	}
	config.listen = {
		type: "websocket",
		port: config.port,
	};
	delete config.port;
}
if (!config.listen) {
	throw die("Invalid configuration: `port` or `listen` missing");
}
if (!Array.isArray(config.listen)) {
	config.listen = [config.listen];
}
config.listen.forEach((listen: ListenOptions) => {
	if (!listen.type) {
		// Default to WebSocket, for backward compatibility
		listen!.type = "websocket";
	}
	if (listen.type === "websocket") {
		// Read TLS key, cert, etc
		replaceKeyFiles(listen, path.dirname(configFile));
	}
});

if (!config.bindings) {
	config.bindings = [];
}

// Create default storage

const storageRoot = path.resolve(path.dirname(configFile), config.storage || "./storage");
const simpleStorage = new storage.ThrottledStorage(new storage.SimpleFileStorage<any>(storageRoot));
storage.setDefaultStorage(simpleStorage);

// Create hub

const hub = new Hub();

// Initialize users

const authenticator = new PlainAuthenticator();
if (typeof config.users === "string") {
	const usersFile = path.resolve(path.dirname(configFile), config.users);
	try {
		config.users = JSON.parse(fs.readFileSync(usersFile, "utf8"));
	} catch (e) {
		die(`Cannot parse users file '${configFile}':`, e);
	}
}
if (config.users !== undefined && typeof config.users !== "object") {
	die("Invalid configuration: `users` should be a filename or object containting username -> password pairs");
}
if (typeof config.users === "object") {
	const users = config.users;
	Object.keys(users).forEach((username: string) => {
		authenticator.setUser(username, users[username]);
	});
}
hub.setAuthenticator(authenticator);

// Set up user permissions

if (config.rights === undefined && config.users === undefined) {
	// Default rights: allow everyone to publish/subscribe.
	hub.setRights({
		"": {
			publish: true,
			subscribe: true,
		},
	});
} else {
	try {
		hub.setRights(config.rights || {});
	} catch (err) {
		die("Invalid configuration: `rights` property: " + err.message);
	}
}

// Instantiate nodes from config file

if (Array.isArray(config.nodes)) { // Backward compatibility, convert to new format
	const oldNodes = <string[]>config.nodes;
	const newNodes: NodesConfig = {};
	oldNodes.forEach((n: string) => {
		if (typeof n !== "string") {
			die("Invalid configuration: `nodes` is given as array, and must then contain only strings");
		}
		newNodes[n] = {
			type: "Exchange",
		};
	});
	config.nodes = newNodes;
}

if (typeof config.nodes !== "object") {
	die("Invalid configuration: `nodes` should be a NodeDefinition map, or an array of strings");
}

const nodesConfig: NodesConfig = config.nodes;
Object.keys(config.nodes).forEach((nodeName: string): void => {
	let def = nodesConfig[nodeName];
	if (typeof def === "string") {
		def = <NodeDefinition>{
			type: def,
		};
	}
	const typeName = def.type;
	const nodeConstructor = nodeClassMap[typeName];
	if (!nodeConstructor) {
		die(`Unknown node type '${typeName}' for node '${nodeName}'`);
	}
	const node = new nodeConstructor(nodeName, def.options);
	hub.add(node);
});

// Setup bindings between nodes

config.bindings.forEach((binding: Binding, index: number): void => {
	const from = hub.findSource(binding.from);
	if (!from) {
		return die(`Unknown Source node '${binding.from}' in \`binding[${index}].from\``);
	}
	const to = hub.findDestination(binding.to);
	if (!to) {
		return die(`Unknown Destination node '${binding.to}' in \`binding[${index}].to\``);
	}
	from.bind(to, binding.pattern);
});

// Initialize and start server

let connectionId = 0;

function startWebSocketServer(options: WSServerOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		options = { ...options }; // clone

		let server: http.Server | https.Server;
		const useTls = !!(options.key || options.pfx);

		options.port = options.port || (useTls ? DEFAULT_PORT_WS : DEFAULT_PORT_WSS);

		if (useTls) {
			server = https.createServer(options);
		} else {
			server = http.createServer();
		}

		const wss = new ws.Server({ server: <any>server, path: "/" });
		wss.on("connection", (conn: ws) => {
			// tslint:disable-next-line:no-unused-expression
			new WSConnection(hub, conn, "websocket" + connectionId++);
		});

		server.listen(options.port, (): void => {
			log.info("WebSocket Server started on port " + options.port, useTls ? "(TLS)" : "");
			resolve(undefined);
		});

		server.on("error", (e: Error): void => {
			reject(e);
		});
	});
}

function startTcpServer(options: TcpServerOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		options = { ...options }; // clone
		options.port = options.port || DEFAULT_PORT_TCP;

		const server = net.createServer((socket: net.Socket) => {
			// tslint:disable-next-line:no-unused-expression
			new TcpConnection(hub, socket, "tcp" + connectionId++);
		});

		server.listen(
			{
				port: options.port,
				host: options.host,
				backlog: options.backlog,
			},
			(): void => {
				log.info("TCP Server started on port " + options.port);
				resolve(undefined);
			}
		);

		server.on("error", (e: Error): void => {
			reject(e);
		});
	});
}

function startTransports(): Promise<void> {
	const serverOptions = Array.isArray(config.listen) ? config.listen : [config.listen];
	return Promise.all(
		serverOptions.map((options: ListenOptions) => {
			switch (options.type) {
				case "websocket":
					return startWebSocketServer(<WSServerOptions>options);
				case "tcp":
					return startTcpServer(<TcpServerOptions>options);
				default:
					throw new Error(`unsupported transport '${options!.type}'`);
			}
		})
	).return();
}

hub.init().then(startTransports).catch((err: Error) => {
	die(`Failed to initialize:`, err);
});
