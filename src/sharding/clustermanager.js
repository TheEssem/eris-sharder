const master = require("cluster");
const cluster = require("./cluster.js");
const numCPUs = require('os').cpus().length;
const logger = require("../utils/logger.js");
const EventEmitter = require("events");
const Eris = require("eris");
const Queue = require("../utils/queue.js");
/**
 * 
 * 
 * @class ClusterManager
 * @extends {EventEmitter}
 */
class ClusterManager extends EventEmitter {
    /**
     * Creates an instance of ClusterManager.
     * @param {any} token 
     * @param {any} mainFile 
     * @param {any} options 
     * @memberof ClusterManager
     */
    constructor(token, mainFile, options) {
        super();
        this.shardCount = options.shards || 0;
        this.clusterCount = options.clusters || numCPUs;
        this.token = token;
        this.clusters = new Map();
        this.maxShards = 0;
        this.queue = new Queue();
        this.eris = new Eris(token);
        this.options = {
            stats: options.stats || false
        };
        this.mainFile = mainFile;
        this.name = options.name || "Eris-Sharder";
        this.firstShardID = 0;
        this.guildsPerShard = options.guildsPerShard || 1300;
        this.webhooks = {};
        this.webhooks.cluster = options.webhooks.cluster || null;
        this.webhooks.shard = options.webhooks.shard || null;
        this.options.debug = options.debug || false;
        this.clientOptions = options.clientOptions || {};
        if (options.stats === true) {
            this.stats = {
                stats: {
                    guilds: 0,
                    users: 0,
                    totalRam: 0,
                    exclusiveGuilds: 0,
                    largeGuilds: 0,
                    clusters: []
                },
                clustersCounted: 0
            }
        }

        this.launch();
    }


    startStats() {

        let self = this;
        setInterval(function () {
            self.stats.stats.guilds = 0;
            self.stats.stats.users = 0;
            self.stats.stats.totalRam = 0;
            self.stats.stats.clusters = [];
            self.stats.clustersCounted = 0;
            self.stats.exclusiveGuilds = 0;
            self.stats.largeGuilds = 0;
            let clusters = Object.entries(master.workers);
            self.executeStats(clusters, 0);
        }, 10 * 1000);
    }

    /**
     * 
     * 
     * @param {any} start 
     * @memberof ClusterManager
     */
    executeStats(clusters, start) {
        let cluster = clusters[start];
        if (cluster) {
            let c = cluster[1];
            c.send({ name: "stats" });
            this.executeStats(clusters, start + 1);
        }
    }


    /**
     * 
     * 
     * @param {any} amount 
     * @param {any} numSpawned 
     * @memberof ClusterManager
     */
    start(amount, numSpawned) {
        if (numSpawned === amount) {
            logger.info("Cluster Manager", "Clusters have been launched!");
            let self = this;
            setTimeout(function () {
                self.roundRobinParser(master.workers);
            }, 100);
        } else {
            let worker = master.fork();
            this.clusters.set(worker.id, { worker: worker, shardCount: 0 });
            logger.info("Cluster Manager", `Launching cluster ${worker.id}`);
            numSpawned = numSpawned + 1;
            let self = this;
            setTimeout(function () {
                self.start(amount, numSpawned);
            }, 100);
        }
    }

    /**
     * 
     * 
     * @memberof ClusterManager
     */
    async launch() {
        if (master.isMaster) {
            process.on("uncaughtException", err => {
                logger.error("Cluster Manager", err.stack);
            });
            this.printLogo();
            setTimeout(() => {
                logger.info("General", "Cluster Manager has started!");
                this.eris.getBotGateway().then(result => {
                    this.calculateShards(result.shards).then(shards => {
                        this.shardCount = shards;
                        this.maxShards = this.shardCount;
                        logger.info("Cluster Manager", `Starting ${this.shardCount} shards in ${this.clusterCount} clusters`);
                        let embed = {
                            title: `Starting ${this.shardCount} shards in ${this.clusterCount} clusters`
                        }
                        this.sendWebhook("cluster", embed);

                        master.setupMaster({
                            silent: true
                        });
                        // Fork workers.
                        this.start(this.clusterCount, 0);
                    });
                });
            }, 50);
        } else if (master.isWorker) {
            const Cluster = new cluster();
            Cluster.spawn();
        }

        master.on('message', (worker, message, handle) => {
            if (message.name) {
                switch (message.name) {
                    case "log":

                        logger.log(`Cluster ${worker.id}`, `${message.msg}`);
                        break;
                    case "debug":
                        if (this.options.debug) {
                            logger.debug(`Cluster ${worker.id}`, `${message.msg}`);
                        }
                        break;
                    case "info":
                        logger.info(`Cluster ${worker.id}`, `${message.msg}`);
                        break;
                    case "warn":
                        logger.warn(`Cluster ${worker.id}`, `${message.msg}`);
                        break;
                    case "error":
                        logger.error(`Cluster ${worker.id}`, `${message.msg}`);
                        break;
                    case "shardsStarted":
                        this.queue.queue.splice(0, 1);
                        if (this.queue.queue.length > 0) {
                            this.queue.executeQueue();
                        }
                        break;
                    case "cluster":
                        this.sendWebhook("cluster", message.embed);
                        break;
                    case "shard":
                        this.sendWebhook("shard", message.embed);
                        break;
                    case "stats":
                        this.stats.stats.guilds += message.stats.guilds;
                        this.stats.stats.users += message.stats.users;
                        this.stats.stats.totalRam += message.stats.ram;
                        let ram = message.stats.ram / 1000000;
                        this.stats.stats.exclusiveGuilds += message.stats.exclusiveGuilds;
                        this.stats.stats.largeGuilds += message.stats.largeGuilds;
                        this.stats.stats.clusters.push({
                            cluster: worker.id,
                            shards: message.stats.shards,
                            guilds: message.stats.guilds,
                            ram: ram,
                            uptime: message.stats.uptime,
                            exclusiveGuilds: message.stats.exclusiveGuilds,
                            largeGuilds: message.stats.largeGuilds
                        });
                        this.stats.clustersCounted += 1;
                        if (this.stats.clustersCounted === this.clusters.size) {
                            function compare(a, b) {
                                if (a.cluster < b.cluster)
                                    return -1;
                                if (a.cluster > b.cluster)
                                    return 1;
                                return 0;
                            }
                            let clusters = this.stats.stats.clusters.sort(compare);
                            this.emit("stats", {
                                guilds: this.stats.stats.guilds,
                                users: this.stats.stats.users,
                                exclusiveGuilds: this.stats.stats.exclusiveGuilds,
                                largeGuilds: this.stats.stats.largeGuilds,
                                totalRam: this.stats.stats.totalRam / 1000000,
                                clusters: clusters
                            });
                        }
                        break;

                    case "fetchUser":
                        this.fetchInfo(0, "fetchUser", message.id);
                        let callback = (user) => {
                            this.clusters.get(message.worker.id);
                            if (cluster) {
                                cluster.worker.send({ name: "fetchReturn", id: id, value: user });
                            }
                            this.removeListener(id, callback);
                        }
                        this.on(id, callback);
                        break;
                    case "fetchGuild":
                        this.fetchInfo(0, "fetchGuild", message.id);
                        let callback1 = (guild) => {
                            this.clusters.get(message.worker.id);
                            if (cluster) {
                                cluster.worker.send({ name: "fetchReturn", id: id, value: guild });
                            }
                            this.removeListener(id, callback1);
                        }
                        this.on(id, callback1);
                        break;
                    case "fetchChannel":
                        this.fetchInfo(0, "fetchChannel", message.id);
                        let callback2 = (channel) => {
                            this.clusters.get(message.worker.id);
                            if (cluster) {
                                cluster.worker.send({ name: "fetchReturn", id: id, value: channel });
                            }
                            pthis.removeListener(id, callback2);
                        }
                        this.on(id, callback2);
                        break;
                    case "fetchReturn":
                        this.emit(id, message.value);
                        break;
                    case "broadcast":
                        this.broadcast(1, message.msg);
                        break;
                    case "send":
                        this.sendTo(message.cluster, message.msg)
                        break;
                }
            }
        });

        master.on('disconnect', (worker) => {
            logger.warn("Cluster Manager", `cluster ${worker.id} disconnected. Restarting.`);
        });

        master.on('exit', (worker, code, signal) => {
            this.restartCluster(worker, code, signal);
        });

        this.queue.on("execute", item => {
            let cluster = this.clusters.get(item.item);
            if (cluster) {
                cluster.worker.send(item.value);
            }
        });
    }


    /**
     * 
     * 
     * @param {any} clusters 
     * @memberof ClusterManager
     */
    roundRobinParser(clusters) {
        let clusters1 = Object.entries(clusters);
        this.roundRobin(clusters1, 0);
    }

    /**
     * 
     * 
     * @param {any} clusters 
     * @param {any} start 
     * @memberof ClusterManager
     */
    roundRobin(clusters, start) {
        if (this.shardCount > 0) {
            let cluster = clusters[start];
            if (!cluster) {
                start = 0;
                let cluster = clusters[start];
                let c = cluster[1];
                //ic = internal cluster
                let ic = this.clusters.get(c.id);
                let shards = this.shardCount;
                c.send({
                    name: "shards",
                    type: "round-robin",
                    shards: 1
                });
                if (ic.shardCount) {
                    ic.shardCount += 1;
                } else {
                    ic.shardCount = 1;
                }
                this.shardCount = shards - 1;
                let self = this;
                setTimeout(function () {
                    start = start + 1;
                    self.roundRobin(clusters, start);
                }, 50)

            } else {
                let c = cluster[1];
                let shards = this.shardCount
                let ic = this.clusters.get(c.id);
                c.send({
                    name: "shards",
                    type: "round-robin",
                    shards: 1
                });
                if (ic.shardCount) {
                    ic.shardCount += 1;
                } else {
                    ic.shardCount = 1;
                }
                this.shardCount = shards - 1;
                let self = this;
                setTimeout(function () {
                    start = start + 1;
                    self.roundRobin(clusters, start);
                }, 50)
            }
        } else {
            this.startupShards(1);
        }
    }


    /**
     * 
     * 
     * @param {any} start 
     * @memberof ClusterManager
     */
    startupShards(start) {
        let cluster = this.clusters.get(start);
        if (cluster) {
            if (cluster.shardCount === 0) {
                logger.info("Cluster Manager", `All shards spread`);
                if (this.stats) {
                    this.startStats();
                }
            } else {
                let firstShardID = this.firstShardID;
                let lastShardID = (firstShardID + cluster.shardCount) - 1;
                this.queue.queueItem({
                    item: cluster.worker.id,
                    value: {
                        id: cluster.worker.id,
                        name: "connect",
                        firstShardID: firstShardID,
                        lastShardID: lastShardID,
                        maxShards: this.maxShards,
                        token: this.token,
                        file: this.mainFile,
                        clientOptions: this.clientOptions
                    }
                });
                this.firstShardID = lastShardID + 1;
                cluster.firstShardID = firstShardID;
                cluster.lastShardID = lastShardID;
                this.startupShards(start + 1);
            }
        } else {
            logger.info("Cluster Manager", `All shards spread`);
            if (this.stats) {
                this.startStats();
            }
        }
    }

    /**
     * 
     * 
     * @param {any} type 
     * @param {any} embed 
     * @memberof ClusterManager
     */
    sendWebhook(type, embed) {
        let id = this.webhooks[type].id;
        let token = this.webhooks[type].token;
        if (id && token) {
            this.eris.executeWebhook(id, token, { embeds: [embed] });
        }
    }

    printLogo() {
        let art = require("ascii-art");
        console.log("_______________________________________________________________________________");
        art.font(this.name, 'Doom', function (rendered) {
            console.log(rendered);
            console.log("_______________________________________________________________________________\n");
        });
    }

    restartCluster(worker, code, signal) {
        logger.warn("Cluster Manager", `cluster ${worker.id} died. Restarting.`);
        let id = worker.id;
        let cluster = this.clusters.get(id);
        let embed = {
            title: `Cluster ${id} died with code ${code}. Restarting...`,
            description: `Shards ${cluster.firstShardID} - ${cluster.lastShardID}`
        }
        this.sendWebhook("cluster", embed);
        let shards = cluster.shardCount;
        let worker1 = master.fork();
        worker1.id = id;
        this.clusters.delete(worker.id);
        let newCluster = {};
        newCluster.shardCount = shards;
        newCluster.firstShardID = cluster.firstShardID;
        newCluster.lastShardID = cluster.lastShardID;
        newCluster.worker = worker1;
        this.clusters.set(worker1.id, newCluster);
        logger.debug("", `Restarting cluster ${newCluster.worker.id}`);
        this.queue.queueItem({
            item: worker1.id, value: {
                id: worker1.id,
                name: "shards",
                type: "reboot",
                shards: shards,
                firstShardID: newCluster.firstShardID,
                lastShardID: newCluster.lastShardID,
                maxShards: this.maxShards,
                token: this.token,
                file: this.mainFile,
                clientOptions: this.clientOptions
            }
        });
    }
    async calculateShards(shards) {
        if (this.shardCount !== 0) return this.shardCount;
        if (shards === 1) {
            return shards;
        } else {
            let guildCount = shards * 1000;
            let guildsPerShard = this.guildsPerShard;
            let shardsDecimal = guildCount / guildsPerShard;
            let finalShards = Math.ceil(shardsDecimal);
            return finalShards;
        }
    }
    fetchInfo(start, type, value) {
        let worker = this.clusters.get(start);
        if (worker) {
            worker.worker.send({ name: type, value: value });
            this.fetchInfo(start + 1, type, value);
        }
    }

    broadcast(start, message) {
        let worker = this.clusters.get(start);
        if (worker) {
            worker.worker.send(message);
            this.broadcast(start + 1, message);
        }
    }
    sendTo(cluster, message) {
        let worker = this.clusters.get(cluster);
        if (worker) {
            worker.worker.send(messge);
        }
    }
}

module.exports = ClusterManager;
